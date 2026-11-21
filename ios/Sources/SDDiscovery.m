#import "SDDiscovery.h"
#import "SDProtocol.h"

#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <fcntl.h>
#include <unistd.h>
#include <string.h>

static NSString *const kAsk = @"SANDROID?";
static NSString *const kAnswer = @"SANDROID!";

@implementation SDServer

+ (instancetype)serverWithName:(NSString *)name host:(NSString *)host port:(uint16_t)port {
    SDServer *s = [SDServer new];
    s.name = name.length ? name : host;
    s.host = host;
    s.port = port ? port : SD_DEFAULT_PORT;
    s.phase = @"";
    return s;
}

+ (instancetype)serverFromAddress:(NSString *)address {
    NSString *text = [address stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if ([text hasPrefix:@"http://"]) text = [text substringFromIndex:7];
    if (text.length == 0) return nil;
    NSString *host = text;
    uint16_t port = SD_DEFAULT_PORT;
    NSRange colon = [text rangeOfString:@":" options:NSBackwardsSearch];
    if (colon.location != NSNotFound && [text componentsSeparatedByString:@":"].count == 2) {
        host = [text substringToIndex:colon.location];
        NSInteger p = [[text substringFromIndex:colon.location + 1] integerValue];
        if (p > 0 && p < 65536) port = (uint16_t)p;
    }
    if (host.length == 0) return nil;
    return [self serverWithName:host host:host port:port];
}

- (NSString *)key {
    return [NSString stringWithFormat:@"%@:%u", self.host, self.port];
}

- (NSString *)displayAddress {
    return self.port == SD_DEFAULT_PORT ? self.host : [self key];
}

- (NSDictionary *)dictionary {
    return @{@"name" : self.name ?: @"", @"host" : self.host ?: @"", @"port" : @(self.port)};
}

+ (instancetype)fromDictionary:(NSDictionary *)d {
    if (![d isKindOfClass:[NSDictionary class]] || ![d[@"host"] isKindOfClass:[NSString class]]) return nil;
    return [self serverWithName:d[@"name"] host:d[@"host"] port:(uint16_t)[d[@"port"] integerValue]];
}

@end

@implementation SDDiscovery {
    int _fd;
    dispatch_source_t _source;
    NSTimer *_timer;
}

- (instancetype)init {
    if ((self = [super init])) _fd = -1;
    return self;
}

- (void)dealloc {
    [self stop];
}

- (void)start {
    if (_fd >= 0) return;
    int fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (fd < 0) return;
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &one, sizeof one);
    struct sockaddr_in local;
    memset(&local, 0, sizeof local);
    local.sin_len = sizeof local;
    local.sin_family = AF_INET;
    local.sin_addr.s_addr = htonl(INADDR_ANY);
    local.sin_port = 0;
    bind(fd, (struct sockaddr *)&local, sizeof local);
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
    _fd = fd;

    _source = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, (uintptr_t)fd, 0, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
    __weak SDDiscovery *weakSelf = self;
    dispatch_source_set_event_handler(_source, ^{
        [weakSelf readFrom:fd];
    });
    dispatch_source_set_cancel_handler(_source, ^{
        close(fd);
    });
    dispatch_resume(_source);

    [self ask];
    _timer = [NSTimer scheduledTimerWithTimeInterval:1.5 target:self selector:@selector(ask) userInfo:nil repeats:YES];
}

- (void)stop {
    [_timer invalidate];
    _timer = nil;
    if (_source) {
        dispatch_source_cancel(_source);
        _source = nil;
    }
    _fd = -1;
}

- (void)sendTo:(in_addr_t)address {
    struct sockaddr_in to;
    memset(&to, 0, sizeof to);
    to.sin_len = sizeof to;
    to.sin_family = AF_INET;
    to.sin_port = htons(SD_DEFAULT_PORT);
    to.sin_addr.s_addr = address;
    const char *msg = kAsk.UTF8String;
    sendto(_fd, msg, strlen(msg), 0, (struct sockaddr *)&to, sizeof to);
}

- (void)ask {
    if (_fd < 0) return;
    [self sendTo:htonl(INADDR_BROADCAST)];
    struct ifaddrs *list = NULL;
    if (getifaddrs(&list) == 0) {
        for (struct ifaddrs *i = list; i != NULL; i = i->ifa_next) {
            if (!i->ifa_addr || i->ifa_addr->sa_family != AF_INET) continue;
            if (!(i->ifa_flags & IFF_UP) || (i->ifa_flags & IFF_LOOPBACK) || !(i->ifa_flags & IFF_BROADCAST)) continue;
            if (!i->ifa_dstaddr) continue;
            struct sockaddr_in *b = (struct sockaddr_in *)i->ifa_dstaddr;
            [self sendTo:b->sin_addr.s_addr];
        }
        freeifaddrs(list);
    }
}

- (void)readFrom:(int)fd {
    char buffer[2048];
    for (;;) {
        struct sockaddr_in from;
        socklen_t fromLen = sizeof from;
        ssize_t n = recvfrom(fd, buffer, sizeof buffer - 1, 0, (struct sockaddr *)&from, &fromLen);
        if (n <= 0) return;
        buffer[n] = 0;
        NSString *text = [[NSString alloc] initWithBytes:buffer length:(NSUInteger)n encoding:NSUTF8StringEncoding];
        if (![text hasPrefix:kAnswer]) continue;
        NSData *json = [[text substringFromIndex:kAnswer.length] dataUsingEncoding:NSUTF8StringEncoding];
        NSDictionary *info = [NSJSONSerialization JSONObjectWithData:json options:0 error:nil];
        if (![info isKindOfClass:[NSDictionary class]]) continue;
        char ip[INET_ADDRSTRLEN] = {0};
        inet_ntop(AF_INET, &from.sin_addr, ip, sizeof ip);
        NSString *host = [NSString stringWithUTF8String:ip];
        NSString *name = [info[@"name"] isKindOfClass:[NSString class]] ? info[@"name"] : host;
        uint16_t port = (uint16_t)[info[@"port"] integerValue];
        SDServer *server = [SDServer serverWithName:name host:host port:port];
        server.phase = [info[@"phase"] isKindOfClass:[NSString class]] ? info[@"phase"] : @"";
        dispatch_async(dispatch_get_main_queue(), ^{
            [self.delegate discovery:self didFindServer:server];
        });
    }
}

@end
