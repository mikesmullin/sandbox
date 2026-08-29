# Lightweight /proc snapshot so the control room can draw mycloud-style gauges
# without the glibc mycloud-probe.

prev = null

readCpu = ->
  text = await Bun.file('/proc/stat').text()
  parts = text.split('\n')[0].split /\s+/
  nums = (Number(x) or 0 for x in parts.slice(1, 8))
  idle = (nums[3] or 0) + (nums[4] or 0)
  total = nums.reduce ((a, b) -> a + b), 0
  { idle, total }

readMem = ->
  text = await Bun.file('/proc/meminfo').text()
  kv = {}
  for line in text.split '\n'
    m = line.match /^(\w+):\s+(\d+)/
    continue unless m
    kv[m[1]] = Number(m[2]) * 1024
  total = kv.MemTotal or 1
  avail = kv.MemAvailable or kv.MemFree or 0
  { used: Math.max(0, total - avail), total }

readDisk = ->
  st = Bun.spawnSync ['df', '-k', '/workspace'], stdout: 'pipe'
  out = new TextDecoder().decode(st.stdout or '').trim().split('\n')
  row = (out[out.length - 1] or '').split /\s+/
  total = (Number(row[1]) or 0) * 1024
  used = (Number(row[2]) or 0) * 1024
  { used, total, name: row[5] or row[0] or '/workspace' }

readNet = ->
  text = await Bun.file('/proc/net/dev').text()
  rx = 0
  tx = 0
  for line, i in text.split '\n'
    continue if i < 2
    continue if line.includes 'lo:'
    p = line.trim().split /\s+/
    continue unless p.length > 9
    rx += Number(p[1]) or 0
    tx += Number(p[9]) or 0
  { rx, tx }

readDiskIo = ->
  text = await Bun.file('/proc/diskstats').text()
  rd = 0
  wr = 0
  for line in text.split '\n'
    p = line.trim().split /\s+/
    continue unless p.length > 9
    name = p[2] or ''
    continue if /^(loop|ram|zram|dm-)/.test name
    rd += (Number(p[5]) or 0) * 512
    wr += (Number(p[9]) or 0) * 512
  { rd, wr }

export sampleTelem = ->
  now = Date.now()
  [cpu, mem, disk, net, io] = await Promise.all [
    readCpu(), readMem(), readDisk(), readNet(), readDiskIo()
  ]
  cores = 1
  try
    cores = Math.max 1, (await Bun.file('/proc/cpuinfo').text()).split(/^processor/m).length - 1
  catch
    cores = 1
  cpuPct = 0
  netRxBps = 0
  netTxBps = 0
  diskReadBps = 0
  diskWriteBps = 0
  if prev?
    dt = Math.max 0.2, (now - prev.t) / 1000
    dTot = cpu.total - prev.total
    dIdle = cpu.idle - prev.idle
    cpuPct = if dTot > 0 then Math.max 0, Math.min 100, (1 - dIdle / dTot) * 100 else 0
    netRxBps = Math.max 0, (net.rx - prev.rx) / dt
    netTxBps = Math.max 0, (net.tx - prev.tx) / dt
    diskReadBps = Math.max 0, (io.rd - prev.rd) / dt
    diskWriteBps = Math.max 0, (io.wr - prev.wr) / dt
  prev =
    t: now
    idle: cpu.idle
    total: cpu.total
    rx: net.rx
    tx: net.tx
    rd: io.rd
    wr: io.wr
  ramPct = if mem.total then (mem.used / mem.total) * 100 else 0
  diskPct = if disk.total then (disk.used / disk.total) * 100 else 0
  {
    ts: now
    cpu_pct: Math.round(cpuPct * 10) / 10
    cpu_cores: cores
    ram_used: mem.used
    ram_total: mem.total
    ram_pct: Math.round(ramPct * 10) / 10
    disk_used: disk.used
    disk_total: disk.total
    disk_pct: Math.round(diskPct * 10) / 10
    disk_name: disk.name
    net_rx_bps: netRxBps
    net_tx_bps: netTxBps
    disk_read_bps: diskReadBps
    disk_write_bps: diskWriteBps
    gpu_pct: 0
    vram_used: 0
    vram_total: 0
  }
