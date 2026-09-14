"""Private Codex test terminal; answer terminal queries and retain local evidence."""
import errno
import fcntl
import json
import os
import pty
import signal
import struct
import sys
import termios

cwd, logfile, raw_args = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvp('codex', ['codex'] + json.loads(raw_args))

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))

def stop(signum, frame):
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
with open(logfile, 'wb', buffering=0) as log:
    try:
        while True:
            data = os.read(fd, 65536)
            if not data:
                break
            log.write(data)
            if b'\x1b[6n' in data:
                os.write(fd, b'\x1b[1;1R')
            if b'\x1b[c' in data:
                os.write(fd, b'\x1b[?1;2c')
    except OSError as error:
        if error.errno != errno.EIO:
            raise
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 1)
