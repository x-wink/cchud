"""为升级前已打开的Codex前台登记一次性退出租约；macOS kqueue / Linux pidfd等待精确进程退出。"""

import argparse
import fcntl
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import time


def watch(pid, state_dir, session, hook):
    identity = subprocess.run(['ps', '-p', str(pid), '-o', 'uid=,tty=,comm='],
                              capture_output=True, text=True, check=True).stdout.strip().split(None, 2)
    if len(identity) != 3 or int(identity[0]) != os.getuid() or identity[1] in ('?', '??') or Path(identity[2]).name != 'codex':
        raise ValueError('只能接管同用户、有终端的Codex前台，不能接管后台服务')
    if sys.platform == 'darwin':
        observer = select.kqueue()
        observer.control([select.kevent(pid, filter=select.KQ_FILTER_PROC,
                                       flags=select.KQ_EV_ADD | select.KQ_EV_ENABLE | select.KQ_EV_ONESHOT,
                                       fflags=select.KQ_NOTE_EXIT)], 0)
        ended = lambda: bool(observer.control([], 1, 0))
        wait = lambda: observer.control([], 1, None)
    elif hasattr(os, 'pidfd_open'):
        handle = os.pidfd_open(pid)
        observer = select.poll()
        observer.register(handle, select.POLLIN)
        ended = lambda: bool(observer.poll(0))
        wait = lambda: observer.poll()
    else:
        raise RuntimeError('本平台没有精确进程退出通知，请通过租约启动入口重开Codex')
    record = json.loads((state_dir / f'{session}.json').read_text())
    if record.get('source') != 'codex' or not record.get('transcript'):
        raise ValueError('需要现有Codex状态档与transcript身份')
    clients = state_dir / '.clients'
    clients.mkdir(parents=True, exist_ok=True)
    lease = clients / f'adopt-{pid}-{time.time_ns()}.lock'
    with lease.open('x+') as stream:
        os.chmod(lease, 0o600)
        fcntl.flock(stream, fcntl.LOCK_EX)
        if ended():
            raise RuntimeError('前台已退出，未登记租约')
        messages = [
            {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'cchud_adopt', 'version': '1'}}},
            {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'attach_client', 'arguments': {'session_id': session, 'transcript': record['transcript']}}},
        ]
        result = subprocess.run([str(hook), 'owner-mcp'], input='\n'.join(json.dumps(m) for m in messages) + '\n',
                                capture_output=True, text=True, check=True,
                                env={**os.environ, 'CCHUD_STATE_DIR': str(state_dir), 'CCHUD_CLIENT_LEASE': str(lease)})
        replies = [json.loads(line) for line in result.stdout.splitlines()]
        if not replies[-1].get('result', {}).get('structuredContent', {}).get('attached'):
            raise RuntimeError('租约登记失败')
        print(json.dumps({'watcher': os.getpid(), 'client': pid, 'session': session, 'lease': str(lease)}), flush=True)
        wait()
        print('前台已退出，租约释放', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pid', type=int, required=True)
    parser.add_argument('--session', required=True)
    parser.add_argument('--state-dir', type=Path, required=True)
    parser.add_argument('--hook', type=Path, required=True)
    args = parser.parse_args()
    watch(args.pid, args.state_dir.resolve(), args.session, args.hook.resolve())
