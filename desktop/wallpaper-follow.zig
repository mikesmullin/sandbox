const std = @import("std");

const poll_interval = std.Io.Duration.fromMilliseconds(50);
const stable_polls_initial: u8 = 1;   // 1 poll after first change → ~50ms immediate
const stable_polls_repeat: u8 = 20;   // 20 polls × 50ms = 1000ms debounce

// Profiling toggle: set WALLFOLLOW_PROFILE=1 to enable timing logs.
// Default is off for production. Enable to profile xdotool/feh latency.
var profiling_enabled: bool = false;
fn enableProfiling() bool {
    return profiling_enabled;
}

// Microsecond timer via Linux clock_gettime(CLOCK_MONOTONIC).
// Bypasses std.time which is just constants on 0.18-dev.
fn nowMicros() u64 {
    var ts: std.os.linux.timespec = undefined;
    _ = std.os.linux.clock_gettime(
        std.os.linux.CLOCK.MONOTONIC,
        &ts,
    );
    return @as(u64, @intCast(ts.sec)) * 1_000_000 +
        @as(u64, @intCast(@divTrunc(ts.nsec, 1_000)));
}

const Geometry = struct {
    width: u32,
    height: u32,

    fn eql(a: Geometry, b: Geometry) bool {
        return a.width == b.width and
            a.height == b.height;
    }
};

fn getGeometry(
    gpa: std.mem.Allocator,
    io: std.Io,
) !Geometry {
    const argv = [_][]const u8{
        "xdotool",
        "getdisplaygeometry",
    };

    const start_us = if (enableProfiling()) nowMicros() else 0;
    const result = try std.process.run(
        gpa,
        io,
        .{
            .argv = &argv,
        },
    );
    const delta_us = if (enableProfiling()) nowMicros() - start_us else 0;
    if (enableProfiling()) std.log.info("xdotool: {d}us", .{delta_us});
    defer gpa.free(result.stdout);
    defer gpa.free(result.stderr);

    switch (result.term) {
        .exited => |code| {
            if (code != 0) {
                std.log.err(
                    "xdotool failed with exit code {d}: {s}",
                    .{
                        code,
                        std.mem.trim(
                            u8,
                            result.stderr,
                            " \t\r\n",
                        ),
                    },
                );
                return error.XdotoolFailed;
            }
        },
        else => |term| {
            std.log.err(
                "xdotool ended unexpectedly: {}",
                .{term},
            );
            return error.XdotoolFailed;
        },
    }

    const output = std.mem.trim(
        u8,
        result.stdout,
        " \t\r\n",
    );

    var fields = std.mem.tokenizeAny(
        u8,
        output,
        " \t\r\n",
    );

    const width_text =
        fields.next() orelse
        return error.InvalidGeometry;

    const height_text =
        fields.next() orelse
        return error.InvalidGeometry;

    if (fields.next() != null) {
        return error.InvalidGeometry;
    }

    return .{
        .width = try std.fmt.parseInt(
            u32,
            width_text,
            10,
        ),
        .height = try std.fmt.parseInt(
            u32,
            height_text,
            10,
        ),
    };
}

fn applyWallpaper(
    gpa: std.mem.Allocator,
    io: std.Io,
    wallpaper: []const u8,
) !void {
    const argv = [_][]const u8{
        "feh",
        "--no-xinerama",
        "--no-fehbg",
        "--bg-fill",
        wallpaper,
    };

    const start_us = if (enableProfiling()) nowMicros() else 0;
    const result = try std.process.run(
        gpa,
        io,
        .{
            .argv = &argv,
        },
    );
    const delta_us = if (enableProfiling()) nowMicros() - start_us else 0;
    if (enableProfiling()) std.log.info("feh: {d}us", .{delta_us});
    defer gpa.free(result.stdout);
    defer gpa.free(result.stderr);

    switch (result.term) {
        .exited => |code| {
            if (code != 0) {
                std.log.err(
                    "feh failed with exit code {d}: {s}",
                    .{
                        code,
                        std.mem.trim(
                            u8,
                            result.stderr,
                            " \t\r\n",
                        ),
                    },
                );
                return error.FehFailed;
            }
        },
        else => |term| {
            std.log.err(
                "feh ended unexpectedly: {}",
                .{term},
            );
            return error.FehFailed;
        },
    }
}

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;

    // Check WALLFOLLOW_PROFILE env var for profiling
    const profile_val = init.environ_map.get("WALLFOLLOW_PROFILE");
    if (std.mem.eql(u8, profile_val orelse "", "1") or
        std.mem.eql(u8, profile_val orelse "", "true"))
    {
        profiling_enabled = true;
    }

    var args = init.minimal.args.iterate();
    _ = args.next(); // skip argv[0]

    const wallpaper =
        args.next() orelse
        "/home/desktop/Pictures/wallpaper.png";

    std.log.info(
        "starting wallpaper watcher: wallpaper={s}, poll=50ms, initial=50ms, debounce=1000ms",
        .{wallpaper},
    );

    var previous: ?Geometry = null;
    var stable_poll_count: u8 = 0;
    var repaint_pending = false;
    var is_first_resize = true;

    var total_xdotool_us: u64 = 0;
    var xdotool_count: u32 = 0;

    while (true) {
        const loop_start_us = if (enableProfiling()) nowMicros() else 0;
        const current = getGeometry(gpa, io) catch |err| {
            std.log.warn(
                "geometry query failed: {}",
                .{err},
            );

            io.sleep(poll_interval, .awake) catch |sleep_err| {
                std.log.err(
                    "sleep failed: {}",
                    .{sleep_err},
                );
                return sleep_err;
            };

            continue;
        };
        const loop_total_us = if (enableProfiling()) nowMicros() - loop_start_us else 0;
        if (enableProfiling()) {
            total_xdotool_us += loop_total_us;
            xdotool_count += 1;

            // Report timing stats every 100 polls
            if (xdotool_count % 100 == 0) {
                const avg = total_xdotool_us / xdotool_count;
                std.log.info(
                    "STATS: xdotool {d} polls, avg {d}us, total {d}ms",
                    .{ xdotool_count, avg, total_xdotool_us / 1000 },
                );
            }
        }

        if (previous) |old| {
            if (!old.eql(current)) {
                std.log.info(
                    "geometry changed: {d}x{d} -> {d}x{d}",
                    .{
                        old.width,
                        old.height,
                        current.width,
                        current.height,
                    },
                );

                previous = current;
                stable_poll_count = 0;
                repaint_pending = true;
            } else if (repaint_pending) {
                const threshold = if (is_first_resize)
                    stable_polls_initial
                else
                    stable_polls_repeat;

                if (stable_poll_count < threshold) {
                    stable_poll_count += 1;
                }

                if (stable_poll_count >= threshold) {
                    std.log.info(
                        "geometry settled at {d}x{d}; applying wallpaper",
                        .{
                            current.width,
                            current.height,
                        },
                    );

                    applyWallpaper(
                        gpa,
                        io,
                        wallpaper,
                    ) catch |err| {
                        std.log.err(
                            "wallpaper update failed: {}; retrying after debounce",
                            .{err},
                        );

                        stable_poll_count = 0;

                        io.sleep(
                            poll_interval,
                            .awake,
                        ) catch |sleep_err| {
                            return sleep_err;
                        };

                        continue;
                    };

                    repaint_pending = false;
                    stable_poll_count = 0;
                    is_first_resize = false;
                }
            }
        } else {
            previous = current;

            std.log.info(
                "initial geometry: {d}x{d}",
                .{
                    current.width,
                    current.height,
                },
            );
        }

        io.sleep(poll_interval, .awake) catch |err| {
            std.log.err("sleep failed: {}", .{err});
            return err;
        };
    }
}
