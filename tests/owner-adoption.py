"""用自己启动的伪Codex前台验证升级接管，后台写者锁在前台退出后继续持有。"""
import fcntl
import json
import os
from pathlib import Path
import pty
import shutil
import signal
import subprocess
import sys
import tempfile

binary = Path(sys.argv[1]).resolve()
root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='cchud-adopt-') as directory:
    directory = Path(directory)
    fake = directory / 'codex'
    shutil.copyfile(shutil.which('sleep'), fake)
    fake.chmod(0o755)
    master, slave = pty.openpty()
    def terminal():
        os.setsid()
        fcntl.ioctl(0, __import__('termios').TIOCSCTTY, 0)
    client = subprocess.Popen([str(fake), '60'], stdin=slave, stdout=slave, stderr=slave, preexec_fn=terminal)
    os.close(slave)
    watcher = None
    try:
        state = directory / 'state'
        state.mkdir()
        backend = state / 'backend.lock'
        with backend.open('w+') as locked:
            fcntl.flock(locked, fcntl.LOCK_EX)
            (state / 'session.json').write_text(json.dumps({'version':1,'source':'codex','state':'wait','transcript':'rollout','live_lock':str(backend)}))
            watcher = subprocess.Popen([sys.executable,str(root/'tools/attach-existing-client.py'),'--pid',str(client.pid),
                                        '--session','session','--state-dir',str(state),'--hook',str(binary)],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            readiness = watcher.stdout.readline()
            if not readiness:
                raise RuntimeError(watcher.stderr.read())
            ready = json.loads(readiness)
            assert ready['client'] == client.pid
            env = {**os.environ,'CCHUD_STATE_DIR':str(state)}
            def inspect():
                result = subprocess.run([str(binary),'sessions'],env=env,capture_output=True,text=True,check=True)
                return json.loads(result.stdout)[0]
            assert inspect()['alive'] is True
            assert inspect()['live_lock'] == ready['lease']
            client.kill()
            client.wait(timeout=3)
            assert watcher.wait(timeout=5) == 0, watcher.stderr.read()
            assert inspect()['alive'] is False
            with backend.open('r+') as probe:
                try:
                    fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    pass
                else:
                    raise AssertionError('后台写者锁应继续保持')
            print('旧前台接管通过：强制退出即释放前台租约，后台仍持锁')
    finally:
        if client.poll() is None:
            client.kill()
            client.wait()
        if watcher is not None and watcher.poll() is None:
            watcher.kill()
            watcher.wait()
        os.close(master)
