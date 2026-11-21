#import "SDConnection.h"

#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <netdb.h>
#include <fcntl.h>
#include <poll.h>
#include <unistd.h>
#include <errno.h>
#include <string.h>

#define SD_MAX_MESSAGE (32u * 1024u * 1024u)

static BOOL SDReadAll(int fd, void *buf, size_t len) {
    uint8_t *p = (uint8_t *)buf;
    while (len > 0) {
        ssize_t n = recv(fd, p, len, 0);
        if (n > 0) {
            p += n;
            len -= (size_t)n;
        } else if (n < 0 && errno == EINTR) {
            continue;
        } else {
            return NO;
        }
    }
    return YES;
}

static BOOL SDWriteAll(int fd, const void *buf, size_t len) {
    const uint8_t *p = (const uint8_t *)buf;
    while (len > 0) {
        ssize_t n = send(fd, p, len, 0);
        if (n > 0) {
            p += n;
            len -= (size_t)n;
        } else if (n < 0 && errno == EINTR) {
            continue;
        } else {
            return NO;
        }
    }
    return YES;
}

static int SDConnectWithTimeout(const char *host, uint16_t port, int timeoutMs, NSString **errorOut) {
    struct addrinfo hints;
    memset(&hints, 0, sizeof hints);
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    char portString[8];
    snprintf(portString, sizeof portString, "%u", port);
    struct addrinfo *result = NULL;
    if (getaddrinfo(host, portString, &hints, &result) != 0 || result == NULL) {
        *errorOut = [NSString stringWithFormat:@"Could not find %s on the network.", host];
        return -1;
    }
    int fd = -1;
    int lastError = 0;
    for (struct addrinfo *ai = result; ai != NULL; ai = ai->ai_next) {
        fd = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (fd < 0) continue;
        int flags = fcntl(fd, F_GETFL, 0);
        fcntl(fd, F_SETFL, flags | O_NONBLOCK);
        int r = connect(fd, ai->ai_addr, ai->ai_addrlen);
        if (r != 0 && errno == EINPROGRESS) {
            struct pollfd p = {.fd = fd, .events = POLLOUT, .revents = 0};
            r = poll(&p, 1, timeoutMs);
            if (r == 1) {
                int so = 0;
                socklen_t soLen = sizeof so;
                getsockopt(fd, SOL_SOCKET, SO_ERROR, &so, &soLen);
                r = so == 0 ? 0 : -1;
                if (so) errno = so;
            } else {
                r = -1;
                errno = ETIMEDOUT;
            }
        }
        if (r == 0) {
            fcntl(fd, F_SETFL, flags & ~O_NONBLOCK);
            break;
        }
        lastError = errno;
        close(fd);
        fd = -1;
    }
    freeaddrinfo(result);
    if (fd < 0) {
        *errorOut = [NSString stringWithFormat:@"Could not connect to %s:%u (%s). Is the server running?", host, port, strerror(lastError)];
    }
    return fd;
}

@implementation SDConnection {
    int _fd;
    BOOL _closed;
    BOOL _notifiedClose;
    NSLock *_lock;
    dispatch_queue_t _writeQueue;
}

- (instancetype)initWithHost:(NSString *)host port:(uint16_t)port {
    if ((self = [super init])) {
        _host = [host copy];
        _port = port;
        _fd = -1;
        _lock = [NSLock new];
        _writeQueue = dispatch_queue_create("sandroid.connection.write", DISPATCH_QUEUE_SERIAL);
    }
    return self;
}

- (void)connect {
    NSThread *thread = [[NSThread alloc] initWithTarget:self selector:@selector(readLoop) object:nil];
    thread.name = @"sandroid.connection.read";
    thread.qualityOfService = NSQualityOfServiceUserInteractive;
    [thread start];
}

- (void)readLoop {
    @autoreleasepool {
        NSString *error = nil;
        int fd = SDConnectWithTimeout(self.host.UTF8String, self.port, 6000, &error);
        if (fd < 0) {
            [self finishWithError:error];
            return;
        }
        int one = 1;
        setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
        setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &one, sizeof one);
        int bufferSize = 1024 * 1024;
        setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &bufferSize, sizeof bufferSize);

        [_lock lock];
        BOOL cancelled = _closed;
        if (!cancelled) _fd = fd;
        [_lock unlock];
        if (cancelled) {
            close(fd);
            [self finishWithError:nil];
            return;
        }
        _connected = YES;
        dispatch_async(dispatch_get_main_queue(), ^{
            [self.delegate connectionDidConnect:self];
        });

        uint8_t header[5];
        for (;;) {
            @autoreleasepool {
                if (!SDReadAll(fd, header, 5)) break;
                uint32_t length = ((uint32_t)header[1] << 24) | ((uint32_t)header[2] << 16) | ((uint32_t)header[3] << 8) | (uint32_t)header[4];
                if (length > SD_MAX_MESSAGE) {
                    error = @"The server sent something unexpected.";
                    break;
                }
                NSMutableData *payload = [NSMutableData dataWithLength:length];
                if (length > 0 && !SDReadAll(fd, payload.mutableBytes, length)) break;
                id<SDConnectionDelegate> delegate = self.delegate;
                [delegate connection:self didReceiveMessage:header[0] payload:payload];
            }
        }
        [self finishWithError:error ?: @"The connection to the server was lost."];
    }
}

- (void)finishWithError:(NSString *)error {
    [_lock lock];
    int fd = _fd;
    _fd = -1;
    BOOL byUser = _closed;
    _closed = YES;
    BOOL notify = !_notifiedClose;
    _notifiedClose = YES;
    [_lock unlock];
    _connected = NO;
    if (fd >= 0) {
        // Close on the write queue so no write can use a recycled descriptor.
        dispatch_async(_writeQueue, ^{
            close(fd);
        });
    }
    if (notify) {
        NSString *message = byUser ? nil : error;
        dispatch_async(dispatch_get_main_queue(), ^{
            [self.delegate connection:self didCloseWithError:message];
        });
    }
}

- (void)close {
    [_lock lock];
    _closed = YES;
    int fd = _fd;
    [_lock unlock];
    if (fd >= 0) shutdown(fd, SHUT_RDWR);
}

- (BOOL)writeNow:(uint8_t)type payload:(NSData *)payload {
    [_lock lock];
    int fd = _fd;
    [_lock unlock];
    if (fd < 0) return NO;
    uint32_t length = (uint32_t)payload.length;
    uint8_t header[5] = {type, (uint8_t)(length >> 24), (uint8_t)(length >> 16), (uint8_t)(length >> 8), (uint8_t)length};
    BOOL ok;
    if (length < 64 * 1024) {
        NSMutableData *all = [NSMutableData dataWithCapacity:5 + length];
        [all appendBytes:header length:5];
        [all appendData:payload];
        ok = SDWriteAll(fd, all.bytes, all.length);
    } else {
        ok = SDWriteAll(fd, header, 5) && SDWriteAll(fd, payload.bytes, length);
    }
    if (!ok) shutdown(fd, SHUT_RDWR);
    return ok;
}

- (void)send:(uint8_t)type payload:(NSData *)payload {
    [self send:type payload:payload completion:nil];
}

- (void)send:(uint8_t)type payload:(NSData *)payload completion:(void (^)(BOOL))completion {
    NSData *data = payload ?: [NSData data];
    dispatch_async(_writeQueue, ^{
        BOOL ok = [self writeNow:type payload:data];
        if (completion) completion(ok);
    });
}

- (void)sendJSON:(uint8_t)type object:(id)object {
    NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
    [self send:type payload:data];
}

- (BOOL)sendSync:(uint8_t)type payload:(NSData *)payload {
    NSData *data = payload ?: [NSData data];
    __block BOOL ok = NO;
    dispatch_sync(_writeQueue, ^{
        ok = [self writeNow:type payload:data];
    });
    return ok;
}

@end
