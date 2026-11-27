/*
 * voice — thin TTS client for the sandbox image.
 *
 * Exactly two things, in sequence:
 *   1. POST {"text":"...", ["voice":"...",] "mode":"download"} to a TTS HTTP
 *      endpoint on the host, and save the response body (wav bytes).
 *   2. Run `paplay <file>` so the narration plays inside the sandbox's
 *      PipeWire/PulseAudio stack.
 *
 * It BLOCKS until playback finishes: the caller sequences narration this way
 * (text in, sound in, done), so the exit code means "the sound has played",
 * never "the request was sent".
 *
 * No dependencies beyond libc + POSIX sockets. Built static for
 * x86_64-linux-musl via build-voice.sh.
 *
 * Exit codes: 0 = fetch+save+playback ok (or dry-run)  1 = fetch/HTTP/
 * playback failure (details on stderr)  2 = usage error (usage on stderr).
 */

#define _POSIX_C_SOURCE 200809L

#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

#define DEFAULT_URL   "http://host.containers.internal:3125/speak"
#define FETCH_TIMEOUT_SECS 60
#define MAX_BODY (64 * 1024 * 1024)

static void die(const char *msg)
{
    fprintf(stderr, "voice: %s\n", msg);
    exit(1);
}

static void usage(FILE *out)
{
    /* Usage text doubles as the error message source, so keep it one screen. */
    fprintf(out,
        "Usage: voice say [--voice NAME] [--url URL] [--dry-run] TEXT...\n"
        "       voice [--voice NAME] [--url URL] [--dry-run] TEXT...\n"
        "       voice --help\n"
        "\n"
        "Fetch synthesized speech from the TTS HTTP API and play it via paplay.\n"
        "TEXT args are joined with spaces.\n"
        "\n"
        "Options:\n"
        "  --voice NAME   voice name (default: the server's own default preset)\n"
        "  --url URL      TTS endpoint (default: $VOICE_TTS_URL, else %s)\n"
        "  --dry-run      fetch and write the wav to voice-out.wav in the CWD\n"
        "                 and print its size; do NOT play it\n"
        "  -h, --help     show this help\n"
        "\n"
        "Environment:\n"
        "  VOICE_TTS_URL    default TTS endpoint (overridden by --url)\n"
        "  VOICE_TTS_VOICE  default voice name (overridden by --voice)\n",
        DEFAULT_URL);
}

static void usage_err(const char *msg)
{
    fprintf(stderr, "voice: %s\n\n", msg);
    usage(stderr);
    exit(2);
}

/* SIGALRM handler: a wedged connection must not hang a tool call forever. */
static void on_timeout(int sig)
{
    (void)sig;
    const char *msg = "voice: fetch timed out (60s)\n";
    (void)!write(2, msg, strlen(msg));
    _exit(1);
}

/* Growable byte buffer for the response / decoded body. */
typedef struct { uint8_t *buf; size_t len, cap; } bodybuf_t;

static bodybuf_t bodybuf_new(size_t hint)
{
    bodybuf_t b;
    b.cap = hint < 4096 ? 4096 : hint;
    b.buf = malloc(b.cap);
    if (!b.buf) die("out of memory");
    b.len = 0;
    return b;
}

static void bodybuf_put(bodybuf_t *b, const uint8_t *p, size_t n)
{
    if (b->len + n > MAX_BODY) die("response body too large");
    while (b->len + n > b->cap) {
        b->cap *= 2;
        uint8_t *nb = realloc(b->buf, b->cap);
        if (!nb) die("out of memory");
        b->buf = nb;
    }
    memcpy(b->buf + b->len, p, n);
    b->len += n;
}

/* JSON string escaping: backslash and quote escaped; newlines become \n and
 * any other control character becomes \u00XX. Built by hand (no JSON dep). */
static char *json_escape(const char *s)
{
    size_t cap = strlen(s) * 4 + 16;
    char *buf = malloc(cap);
    if (!buf) die("out of memory");
    size_t used = 0;
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        size_t need = (*p == '"' || *p == '\\' || *p == '\n' || *p == '\r') ? 2
                    : (*p < 0x20) ? 6 : 1;
        if (used + need + 1 > cap) {
            cap *= 2;
            char *nb = realloc(buf, cap);
            if (!nb) die("out of memory");
            buf = nb;
        }
        char *w = buf + used;
        switch (*p) {
        case '"':  *w++ = '\\'; *w++ = '"';  break;
        case '\\': *w++ = '\\'; *w++ = '\\'; break;
        case '\n': *w++ = '\\'; *w++ = 'n';  break;
        case '\r': *w++ = '\\'; *w++ = 'r';  break;
        default:
            if (*p < 0x20) {
                int n = snprintf(w, 8, "\\u%02x", *p);
                used += (size_t)n;
                continue;
            }
            *w++ = (char)*p;
            break;
        }
        used = (size_t)(w - buf);
    }
    buf[used] = '\0';
    return buf;
}

/* Minimal URL parsing: expectations are "http://host[:port][/path]". */
typedef struct { char host[256]; int port; char path[512]; } url_part_t;

static int parse_url(const char *url, url_part_t *out)
{
    const char *rest = strstr(url, "://");
    if (!rest || strncmp(url, "http://", 7) != 0)
        return -1;
    rest += 3;
    const char *slash = strchr(rest, '/');
    size_t host_len;
    if (slash) {
        host_len = (size_t)(slash - rest);
        snprintf(out->path, sizeof(out->path), "%s", slash);
    } else {
        host_len = strlen(rest);
        strcpy(out->path, "/");
    }
    if (host_len == 0 || host_len >= sizeof(out->host))
        return -1;
    snprintf(out->host, sizeof(out->host), "%.*s", (int)host_len, rest);
    char *colon = strchr(out->host, ':');
    if (colon) {
        *colon = '\0';
        int p = atoi(colon + 1);
        if (p <= 0 || p > 65535) return -1;
        out->port = p;
    } else {
        out->port = 80;
    }
    return out->host[0] ? 0 : -1;
}

/* Chunked-body decoder: "<hex>\r\n<data>\r\n" ... "0\r\n". Returns the malloc'd
 * decoded body (caller frees); on a broken stream the bytes decoded so far are
 * returned — a truncated wav header is present at the start either way. */
static uint8_t *decode_chunked(const uint8_t *body, size_t body_len, size_t *out_len)
{
    bodybuf_t out = bodybuf_new(body_len);
    size_t off = 0;
    for (;;) {
        if (off >= body_len) break;
        const char *cur = (const char *)body + off;
        size_t rem = body_len - off;
        const char *nl = memchr(cur, '\n', rem);
        if (!nl) break;
        size_t ll = (size_t)(nl - cur);
        if (ll >= 64) break;
        char linebuf[64];
        memcpy(linebuf, cur, ll);
        linebuf[ll] = '\0';
        char *semi = strchr(linebuf, ';'); /* chunk extensions are legal */
        if (semi) *semi = '\0';
        size_t l2 = strlen(linebuf);
        if (l2 > 0 && linebuf[l2 - 1] == '\r') linebuf[l2 - 1] = '\0';
        long n = strtol(linebuf, NULL, 16);
        off += (size_t)(nl - cur) + 1;           /* -> start of chunk data */
        if (n == 0) break;                       /* terminating chunk */
        if ((size_t)n > body_len - off) break;   /* truncated chunk */
        bodybuf_put(&out, (const uint8_t *)body + off, (size_t)n);
        off += (size_t)n;
        if (off + 1 < body_len && body[off] == '\r' && body[off + 1] == '\n')
            off += 2;                            /* CRLF after chunk data */
        else
            off = body_len;
    }
    *out_len = out.len;
    return out.buf;
}

/* Split raw response into status + decoded body. Returns 0 on success. */
static int parse_response(const uint8_t *raw, size_t raw_len,
                          int *out_status, uint8_t **out_body, size_t *out_body_len)
{
    const uint8_t *boundary = NULL;
    for (size_t i = 0; i + 3 < raw_len; i++) {
        if (raw[i] == '\r' && raw[i+1] == '\n' && raw[i+2] == '\r' && raw[i+3] == '\n') {
            boundary = &raw[i + 4];
            break;
        }
    }
    if (!boundary) return -1;
    size_t hdr_len = (size_t)(boundary - raw) - 4;
    char *hdr = malloc(hdr_len + 1);
    if (!hdr) die("out of memory");
    memcpy(hdr, raw, hdr_len);
    hdr[hdr_len] = '\0';

    /* Status line: first line, second whitespace-delimited token is the code. */
    int status = 0;
    char *nl = strstr(hdr, "\r\n");
    if (nl) {
        char status_line[256];
        size_t sl = (size_t)(nl - hdr);
        if (sl >= sizeof(status_line)) sl = sizeof(status_line) - 1;
        memcpy(status_line, hdr, sl);
        status_line[sl] = '\0';
        char *save = NULL;
        char *tok = strtok_r(status_line, " \t", &save);
        tok = tok ? strtok_r(NULL, " \t", &save) : NULL;
        if (tok) status = atoi(tok);
    }

    /* Header lines: content-length and transfer-encoding (case-insensitive). */
    long content_length = -1;
    int chunked = 0;
    char *hcpy = strdup(hdr);
    if (!hcpy) { free(hdr); return -1; }
    char *hsave = NULL;
    char *line = strtok_r(hcpy, "\r\n", &hsave);
    while (line) {
        if (*line) {
            char *colon = strchr(line, ':');
            if (colon) {
                *colon = '\0';
                char *val = colon + 1;
                while (isspace((unsigned char)*val)) val++;
                size_t vl = strlen(val);
                while (vl > 0 && isspace((unsigned char)val[vl-1])) { val[vl-1] = '\0'; vl--; }
                if (strcasecmp(line, "content-length") == 0)
                    content_length = strtol(val, NULL, 10);
                else if (strcasecmp(line, "transfer-encoding") == 0)
                    if (strstr(val, "chunked")) chunked = 1;
            }
        }
        line = strtok_r(NULL, "\r\n", &hsave);
    }
    free(hcpy);
    free(hdr);

    size_t body_len = raw_len - (size_t)(boundary - raw);
    const uint8_t *body = boundary;

    if (chunked) {
        *out_body = decode_chunked(body, body_len, out_body_len);
    } else {
        *out_body = malloc(body_len ? body_len : 1);
        if (!*out_body) die("out of memory");
        memcpy(*out_body, body, body_len);
        *out_body_len = body_len;
        if (content_length >= 0 && content_length <= (long)*out_body_len)
            *out_body_len = (size_t)content_length;
    }
    *out_status = status;
    return 0;
}

/* Fetch: resolve, connect, write the request, read to EOF, parse.
 * Returns 0 on success; -1 on error (message on stderr). */
static int fail(void)
{
    alarm(0);
    return -1;
}

static int fetch(const char *url, const uint8_t *body, size_t body_len,
                 int *out_status, uint8_t **out_body, size_t *out_body_len)
{
    url_part_t up;
    if (parse_url(url, &up) != 0) {
        fprintf(stderr, "voice: invalid URL (expected http://host[:port][/path])\n");
        return -1;
    }

    /* Wrap the whole fetch (connect + send + recv) in the alarm timeout. */
    signal(SIGALRM, on_timeout);
    alarm(FETCH_TIMEOUT_SECS);

    struct addrinfo hints = {0}, *res = NULL;
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    char portbuf[16];
    snprintf(portbuf, sizeof(portbuf), "%d", up.port);
    if (getaddrinfo(up.host, portbuf, &hints, &res) != 0 || !res) {
        fprintf(stderr, "voice: could not resolve host '%s'\n", up.host);
        return fail();
    }

    int fd = -1;
    for (struct addrinfo *ai = res; ai; ai = ai->ai_next) {
        fd = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (fd < 0) continue;
        if (connect(fd, ai->ai_addr, ai->ai_addrlen) == 0) break;
        close(fd);
        fd = -1;
    }
    freeaddrinfo(res);
    if (fd < 0) {
        fprintf(stderr, "voice: could not connect to %s:%d\n", up.host, up.port);
        return fail();
    }

    /* Request: minimal HTTP/1.1 POST with Host + Connection: close. */
    char hdr[512];
    int hl = snprintf(hdr, sizeof(hdr),
                      "POST %s HTTP/1.1\r\nHost: %s:%d\r\nContent-Type: application/json\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n",
                      up.path, up.host, up.port, body_len);
    if (hl < 0 || (size_t)hl >= sizeof(hdr)) {
        close(fd);
        fprintf(stderr, "voice: URL too long\n");
        return fail();
    }

    size_t left = (size_t)hl;
    const uint8_t *p = (const uint8_t *)hdr;
    while (left > 0) {
        ssize_t n = write(fd, p, left);
        if (n <= 0) {
            close(fd);
            fprintf(stderr, "voice: failed writing request\n");
            return fail();
        }
        p += n;
        left -= (size_t)n;
    }
    size_t boff = 0;
    while (boff < body_len) {
        ssize_t n = write(fd, body + boff, body_len - boff);
        if (n <= 0) {
            close(fd);
            fprintf(stderr, "voice: failed writing request\n");
            return fail();
        }
        boff += (size_t)n;
    }

    /* Read to EOF (Connection: close means the server closes the socket). */
    bodybuf_t resp = bodybuf_new(64 * 1024);
    uint8_t chunk[4096];
    for (;;) {
        ssize_t n = read(fd, chunk, sizeof(chunk));
        if (n > 0) { bodybuf_put(&resp, chunk, (size_t)n); continue; }
        if (n == 0) break;
        if (errno == EINTR) continue;
        break; /* read error — bail with whatever we have */
    }
    alarm(0);
    close(fd);

    int status = -1;
    uint8_t *decoded = NULL;
    size_t decoded_len = 0;
    if (parse_response(resp.buf, resp.len, &status, &decoded, &decoded_len) != 0) {
        free(resp.buf);
        fprintf(stderr, "voice: could not parse TTS response\n");
        return fail();
    }
    free(resp.buf);

    *out_status = status;
    *out_body = decoded;
    *out_body_len = decoded_len;
    return 0;
}

/* Write every byte of a buffer to fd (POSIX write may be short). Returns -1 on failure. */
static int write_all(int fd, const uint8_t *buf, size_t len)
{
    size_t off = 0;
    while (off < len) {
        ssize_t n = write(fd, buf + off, len - off);
        if (n <= 0) return -1;
        off += (size_t)n;
    }
    return 0;
}

int main(int argc, char **argv)
{
    signal(SIGPIPE, SIG_IGN); /* a closed-by-the-server socket must not kill us */

    /* Optional "say" subcommand — the shorthand form of this tool. */
    int i = 1;
    if (i < argc && strcmp(argv[i], "say") == 0) i++;

    const char *url = getenv("VOICE_TTS_URL");
    /* Voice stays NULL when nobody named one: the request then carries no
     * voice field at all and the SERVER's default preset speaks — hardcoding
     * a fallback here would silently override the operator's choice. */
    const char *voice = getenv("VOICE_TTS_VOICE");
    if (!url || !*url) url = DEFAULT_URL;
    if (voice && !*voice) voice = NULL;
    int dry_run = 0;

    /* Collect TEXT args; parse flags anywhere (before, between, after text). */
    size_t text_cap = 4096;
    char *text = malloc(text_cap);
    if (!text) die("out of memory");
    size_t text_len = 0;
    int saw_text = 0;

    while (i < argc) {
        const char *a = argv[i];
        if (strcmp(a, "--help") == 0 || strcmp(a, "-h") == 0) {
            usage(stdout);
            free(text);
            return 0;
        }
        if (strcmp(a, "--dry-run") == 0) { dry_run = 1; i++; continue; }
        if (strcmp(a, "--voice") == 0) {
            if (i + 1 >= argc) usage_err("--voice requires a value");
            voice = argv[i + 1];
            i += 2;
            continue;
        }
        if (strcmp(a, "--url") == 0) {
            if (i + 1 >= argc) usage_err("--url requires a value");
            url = argv[i + 1];
            i += 2;
            continue;
        }
        if (a[0] == '-' && a[1] != '\0')
            usage_err("unknown flag (try --help)");
        size_t need = strlen(a) + 2;
        if (text_len + need > text_cap) {
            text_cap *= 2;
            char *nt = realloc(text, text_cap);
            if (!nt) die("out of memory");
            text = nt;
        }
        if (saw_text) text[text_len++] = ' ';
        strcpy(text + text_len, a);
        text_len += strlen(a);
        saw_text = 1;
        i++;
    }

    if (!saw_text) usage_err("missing TEXT arguments");

    /* Build the JSON request body (escaped). */
    char *esc_text = json_escape(text);
    char *esc_voice = voice ? json_escape(voice) : NULL;
    size_t jcap = strlen(esc_text) + (esc_voice ? strlen(esc_voice) : 0) + 80;
    char *jbody = malloc(jcap);
    if (!jbody) die("out of memory");
    if (esc_voice) {
        snprintf(jbody, jcap, "{\"text\":\"%s\",\"voice\":\"%s\",\"mode\":\"download\"}",
                 esc_text, esc_voice);
    } else {
        /* No voice field: the server's own default_preset speaks. */
        snprintf(jbody, jcap, "{\"text\":\"%s\",\"mode\":\"download\"}", esc_text);
    }

    uint8_t *wav = NULL;
    size_t wav_len = 0;
    int status = -1;
    if (fetch(url, (const uint8_t *)jbody, strlen(jbody), &status, &wav, &wav_len) != 0) {
        free(jbody); free(text); free(esc_text); free(esc_voice);
        return 1;
    }
    free(jbody); free(text); free(esc_text); free(esc_voice);

    if (status < 200 || status >= 300 || wav_len == 0) {
        /* Print status + a truncated body for debugging, never dump the whole
         * thing (a server error message could be huge). */
        size_t show = wav_len < 200 ? wav_len : 200;
        fprintf(stderr, "voice: TTS endpoint returned HTTP %d", status);
        if (wav_len == 0) fprintf(stderr, " with an empty body");
        if (show > 0) {
            fprintf(stderr, "\n  body: ");
            for (size_t k = 0; k < show; k++) {
                int c = wav[k];
                if (c < 32 || c > 126) fprintf(stderr, "\\x%02x", c);
                else fputc(c, stderr);
            }
            if (wav_len > 200) fprintf(stderr, "...");
        }
        fprintf(stderr, "\n");
        free(wav);
        return 1;
    }

    /* Save wav (temp file, or voice-out.wav in dry-run mode). */
    if (dry_run) {
        int f = open("voice-out.wav", O_CREAT | O_WRONLY | O_TRUNC, 0600);
        if (f < 0) {
            fprintf(stderr, "voice: could not open voice-out.wav for writing\n");
            free(wav);
            return 1;
        }
        if (write_all(f, wav, wav_len) != 0) {
            fprintf(stderr, "voice: failed writing voice-out.wav\n");
            close(f);
            unlink("voice-out.wav");
            free(wav);
            return 1;
        }
        close(f);
        printf("wrote voice-out.wav (%zu bytes)\n", wav_len);
        free(wav);
        return 0;
    }

    char tmp_path[256];
    snprintf(tmp_path, sizeof(tmp_path), "/tmp/voice-say-%d.wav", getpid());
    int tf = open(tmp_path, O_CREAT | O_WRONLY | O_TRUNC, 0600);
    if (tf < 0) {
        fprintf(stderr, "voice: could not open temp file %s\n", tmp_path);
        free(wav);
        return 1;
    }
    if (write_all(tf, wav, wav_len) != 0) {
        fprintf(stderr, "voice: failed writing %s\n", tmp_path);
        close(tf);
        unlink(tmp_path);
        free(wav);
        return 1;
    }
    close(tf);
    free(wav);

    /* execvp paplay and block until playback finishes. */
    pid_t pid = fork();
    if (pid < 0) {
        fprintf(stderr, "voice: fork failed\n");
        unlink(tmp_path);
        return 1;
    }
    if (pid == 0) {
        signal(SIGPIPE, SIG_IGN);
        execlp("paplay", "paplay", tmp_path, (char *)NULL);
        const char *msg = "voice: paplay: command not found\n";
        (void)!write(2, msg, strlen(msg));
        _exit(127);
    }
    int status_out = 0;
    while (waitpid(pid, &status_out, 0) < 0) {
        if (errno == EINTR) continue;
        fprintf(stderr, "voice: waitpid failed\n");
        unlink(tmp_path);
        return 1;
    }
    unlink(tmp_path);

    if (WIFEXITED(status_out) && WEXITSTATUS(status_out) == 0)
        return 0;
    if (WIFEXITED(status_out))
        fprintf(stderr, "voice: paplay exited with status %d\n", WEXITSTATUS(status_out));
    else
        fprintf(stderr, "voice: paplay was killed\n");
    return 1;
}
