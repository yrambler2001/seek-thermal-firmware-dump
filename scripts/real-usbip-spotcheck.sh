#!/usr/bin/env bash
# =====================================================================
# The fidelity spot-check: the SAME emulated camera, through a REAL
# Linux kernel USB stack and REAL libusb.
#
# `packages/core/test/emulator/usbip-client.ts` substitutes the host
# controller: it speaks USB/IP on a socket instead of going through libusb.
# That is deliberate (vhci import slots are few, contended, and a process
# that exits without detaching wedges one), but it means the suite's result
# is "the toolkit's protocol stack against real firmware", not "through a
# real USB stack". This script closes that gap on one firmware at a time.
#
# Nothing about the USB stack is faked here. `usbip attach` hands the
# emulator's socket to vhci-hcd, the kernel enumerates it as an ordinary
# device, and libusb talks to the resulting node.
#
#   ./scripts/real-usbip-spotcheck.sh <emu-dir> <corpus-entry-substring>
#
# Needs Docker with a Linux kernel that has CONFIG_USBIP_VHCI_HCD (Docker
# Desktop's LinuxKit kernel does, built in).
#
# MEASURED 2026-09-22, Docker Desktop LinuxKit 6.12.76 aarch64:
#   Compact PRO FF 4.18.2.0  'CompactPRO FF' / 1818B0Z3K6C8
#       GetChipID 18001800a600af001200e300
#       4096 B from armed slot A == the emulator's --flash-out at 0x14030000
#   Nano 300 44.27.3.10       'Nano300'
#       4096 B from armed slot A == the emulator's --flash-out at 0x14030000
# Both GetChipID replies are byte-identical to what the suite records over
# the USB/IP shim, so the shim is not flattering the result.
# =====================================================================
set -euo pipefail

EMU_DIR="${1:-${SEEK_EMU_DIR:-../FW-V1/emu}}"
ENTRY="${2:-4.18.2.0-FF/1818B0Z3K6C8/dump}"
PORT="${SEEK_EMU_PORT:-3248}"
SEED="${SEEK_EMU_FILL_SEED:-388609}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PY="$EMU_DIR/.venv/bin/python"
[ -x "$PY" ] || PY=python3

echo "emulator : $EMU_DIR"
echo "entry    : $ENTRY"
echo "port     : $PORT  (bound to 0.0.0.0 so the container can reach it)"

( cd "$EMU_DIR" && "$PY" seek_emu.py --usbip --usbip-bind 0.0.0.0 --usbip-port "$PORT" \
    --corpus-entry "$ENTRY" --fill-erased "$SEED" --flash-out "$WORK/truth.bin" \
    > "$WORK/emu.log" 2>&1 ) &
EMU_PID=$!
# `wait` after the kill keeps the shell from printing its own job-control
# notice about the emulator it was asked to stop.
trap 'kill "$EMU_PID" 2>/dev/null || true; wait "$EMU_PID" 2>/dev/null || true; rm -rf "$WORK"' EXIT

for _ in $(seq 60); do
  grep -q -- '---USBIP-READY---' "$WORK/emu.log" && break
  sleep 1
done
grep -q -- '---USBIP-READY---' "$WORK/emu.log" || { tail -20 "$WORK/emu.log"; exit 1; }
echo "emulator ready; ground truth in $WORK/truth.bin"

cat > "$WORK/inside.sh" <<SHELL
set -e
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq usbip python3-usb usbutils >/dev/null 2>&1
# The LinuxKit VM is shared between containers, so a previous run's attach may
# still hold a vhci port. Free every one before asking for a new one.
for p in 0 1 2 3 4 5 6 7; do usbip detach -p \$p 2>/dev/null || true; done
sleep 1
usbip --tcp-port $PORT attach -r host.docker.internal -b 1-1
sleep 6
usbip port
# Docker runs no udev, so /dev/bus/usb is never populated for a device that
# appeared after the container started. libusb needs that node, so make it from
# what the kernel already published in sysfs.
B=\$(cat /sys/bus/usb/devices/1-1/busnum); D=\$(cat /sys/bus/usb/devices/1-1/devnum)
mkdir -p /dev/bus/usb/\$(printf %03d \$B)
mknod /dev/bus/usb/\$(printf %03d \$B)/\$(printf %03d \$D) c 189 \$(( (B-1)*128 + D-1 ))
lsusb
python3 - <<'PY'
import time, usb.core
d = None
for _ in range(10):
    d = usb.core.find(idVendor=0x289d)
    if d is not None:
        break
    time.sleep(1)
for f in ('manufacturer', 'product', 'serial'):
    print(' ', f, '=', open('/sys/bus/usb/devices/1-1/' + f).read().strip())
d.set_configuration()
print('GetChipID   :', bytes(d.ctrl_transfer(0xC1, 54, 0, 0, 12, 30000)).hex())
d.ctrl_transfer(0x41, 0x52, 0, 0, bytes([5, 0]), 30000)   # arm slot A
time.sleep(0.2)
print('GetErrorCode:', bytes(d.ctrl_transfer(0xC1, 0x35, 0, 0, 4, 30000)).hex())
buf = b''
while len(buf) < 4096:
    buf += bytes(d.ctrl_transfer(0xC1, 0x4f, 0, 0, 64, 30000))
open('/out/window.bin', 'wb').write(buf)
print('read', len(buf), 'B from the armed slot-A window')
PY
for p in 0 1 2 3 4 5 6 7; do usbip detach -p \$p 2>/dev/null || true; done
SHELL

docker run --rm --privileged -v "$WORK:/out" debian:bookworm-slim bash /out/inside.sh

python3 - "$WORK/truth.bin" "$WORK/window.bin" <<'PY'
import sys
truth = open(sys.argv[1], 'rb').read()
got = open(sys.argv[2], 'rb').read()
off = 0x30000
same = sum(1 for a, b in zip(truth[off:off + len(got)], got) if a == b)
print(f'{same}/{len(got)} bytes match the emulator flash-out at 0x14030000')
sys.exit(0 if same == len(got) else 1)
PY
