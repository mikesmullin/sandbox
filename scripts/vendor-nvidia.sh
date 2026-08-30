#!/usr/bin/env bash
# Copy host NVIDIA userspace into vendor/nvidia for the desktop image.
# Kind pods cannot see laptop /usr/lib; they only see the Kind node.
# Driver version must match the host (nvidia-smi). Re-run after driver updates.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/vendor/nvidia"
rm -rf "$DEST"
mkdir -p "$DEST/lib" \
  "$DEST/share/glvnd/egl_vendor.d" \
  "$DEST/share/vulkan/icd.d" \
  "$DEST/share/egl/egl_external_platform.d"

LIB=""
for d in /usr/lib64 /usr/lib/x86_64-linux-gnu /usr/lib; do
  if compgen -G "$d/libnvidia-glcore.so*" >/dev/null; then
    LIB="$d"
    break
  fi
done
if [[ -z "$LIB" ]]; then
  echo "[vendor-nvidia] no NVIDIA userspace on host; WebGL will be software" >&2
  exit 0
fi

shopt -s nullglob
for pat in \
  'libnvidia*.so*' \
  'libGLX_nvidia.so*' \
  'libEGL_nvidia.so*' \
  'libGLESv1_CM_nvidia.so*' \
  'libGLESv2_nvidia.so*' \
  'libcuda.so*' \
  'libnvcuvid.so*' \
  'libvulkan.so*'
do
  for f in "$LIB"/$pat; do
    cp -a "$f" "$DEST/lib/"
  done
done

[[ -f /usr/share/glvnd/egl_vendor.d/10_nvidia.json ]] && \
  cp -a /usr/share/glvnd/egl_vendor.d/10_nvidia.json "$DEST/share/glvnd/egl_vendor.d/"
[[ -f /usr/share/vulkan/icd.d/nvidia_icd.json ]] && \
  cp -a /usr/share/vulkan/icd.d/nvidia_icd.json "$DEST/share/vulkan/icd.d/"
for f in /usr/share/egl/egl_external_platform.d/*nvidia*; do
  [[ -f "$f" ]] && cp -a "$f" "$DEST/share/egl/egl_external_platform.d/"
done

echo "[vendor-nvidia] $LIB -> $DEST/lib ($(du -sh "$DEST/lib" | awk '{print $1}'))"
