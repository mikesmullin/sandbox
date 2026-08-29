# Coffee RSH client — thin interface over the Zig rsh `client` binary.
# Future: pure Coffee/UDP protocol; today we reuse /workspace/cli/rsh which is
# wire-compatible with gl1 rshd.
#
#   RshClient = require './rsh-client'
#   rsh = new RshClient target: '10.1.10.57:9000'
#   { stdout, stderr, code } = await rsh.exec ['/bin/ls', '-la', path]

{ spawn } = require 'node:child_process'
{ existsSync } = require 'node:fs'
{ resolve } = require 'node:path'

DEFAULT_TARGET = process.env.MCP_RSH_TARGET or process.env.RSH_TARGET or '10.1.10.57:9000'
DEFAULT_HOME = process.env.MCP_RSH_HOME or '/Users/msmullin'
DEFAULT_TIMEOUT = Number(process.env.MCP_RSH_TIMEOUT_MS or 60_000)

CLIENT_CANDIDATES = [
  process.env.RSH_CLIENT
  '/workspace/cli/rsh/zig-out/bin/client'
  resolve(__dirname, '../../../cli/rsh/zig-out/bin/client')
].filter Boolean

findClient = ->
  for p in CLIENT_CANDIDATES
    return p if existsSync p
  null

class RshClient
  constructor: (opts = {}) ->
    @target = opts.target or DEFAULT_TARGET
    @home = opts.home or DEFAULT_HOME
    @timeoutMs = opts.timeoutMs ? DEFAULT_TIMEOUT
    @clientPath = opts.clientPath or findClient()

  available: ->
    Boolean @clientPath

  expand: (s) ->
    out = String(s ? '')
    if out.indexOf('~/') is 0
      out = @home + out.slice(1)
    else if out is '~'
      out = @home
    out

  # Run argv on remote. Returns { code, stdout, stderr, command, target }
  exec: (argv, opts = {}) ->
    unless @clientPath
      return Promise.resolve
        code: 127
        stdout: ''
        stderr: "rsh client binary not found (set RSH_CLIENT). tried: #{CLIENT_CANDIDATES.join ', '}"
        command: (argv or []).join ' '
        target: @target

    remoteArgv = (argv or []).map (a) => @expand a
    line = remoteArgv.join ' '

    if opts.cwd
      c = @expand opts.cwd
      escaped = remoteArgv.map (a) ->
        "'" + String(a).replace(/'/g, "'\\''") + "'"
      .join ' '
      cEsc = String(c).replace /'/g, "'\\''"
      remoteArgv = ['/bin/sh', '-c', "cd '#{cEsc}' && exec #{escaped}"]

    procArgs = [@target, '--', remoteArgv...]

    new Promise (resolvePromise) =>
      child = spawn @clientPath, procArgs,
        stdio: ['ignore', 'pipe', 'pipe']
        env: process.env
      stdout = ''
      stderr = ''
      timer = setTimeout ->
        try child.kill 'SIGKILL' catch
      , @timeoutMs

      child.stdout?.on 'data', (d) -> stdout += d.toString()
      child.stderr?.on 'data', (d) -> stderr += d.toString()
      child.on 'error', (err) =>
        clearTimeout timer
        resolvePromise
          code: 127
          stdout: stdout
          stderr: stderr + (err.message or String err)
          command: line
          target: @target
      child.on 'close', (code) =>
        clearTimeout timer
        resolvePromise
          code: code ? 0
          stdout: stdout
          stderr: stderr
          command: line
          target: @target

  # Convenience: remote bash -c script (~ expanded).
  # Real /bin/bash so process substitution etc. work (unlike POSIX /bin/sh).
  # opts.cwd → cd into that dir inside bash -c (default from term-rsh / agent coffee).
  bash: (script, opts = {}) ->
    s = String script ? ''
    s = s.replace /(^|[\s"'])~\//g, "$1#{@home}/"
    s = s.replace /(^|[\s"'])~/g, "$1#{@home}"
    cwd = if opts.cwd? and String(opts.cwd).trim() then @expand(String(opts.cwd).trim()) else ''
    if cwd
      cEsc = "'" + String(cwd).replace(/'/g, "'\\''") + "'"
      s = "cd #{cEsc} || exit 1; #{s}"
      return @exec ['/bin/bash', '-c', s], Object.assign({}, opts, { cwd: undefined })
    @exec ['/bin/bash', '-c', s], opts

  listDir: (path, opts = {}) ->
    @exec ['/bin/ls', '-la', @expand path], opts

module.exports = { RshClient, findClient, DEFAULT_TARGET, DEFAULT_HOME }
