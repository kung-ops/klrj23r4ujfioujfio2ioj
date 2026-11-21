#import <Foundation/Foundation.h>

@interface SDServer : NSObject
@property (nonatomic, copy) NSString *name;
@property (nonatomic, copy) NSString *host;
@property (nonatomic) uint16_t port;
@property (nonatomic, copy) NSString *phase;
+ (instancetype)serverWithName:(NSString *)name host:(NSString *)host port:(uint16_t)port;
// Parses "192.168.1.20", "192.168.1.20:8080" or "mypc.local:8080".
+ (instancetype)serverFromAddress:(NSString *)address;
- (NSString *)key;
- (NSString *)displayAddress;
- (NSDictionary *)dictionary;
+ (instancetype)fromDictionary:(NSDictionary *)dictionary;
@end

@class SDDiscovery;

@protocol SDDiscoveryDelegate <NSObject>
- (void)discovery:(SDDiscovery *)discovery didFindServer:(SDServer *)server; // main thread
@end

// Finds Sandroid servers on the Wi-Fi: broadcasts "SANDROID?" to UDP port 8080
// and collects the "SANDROID!{json}" answers.
@interface SDDiscovery : NSObject
@property (nonatomic, weak) id<SDDiscoveryDelegate> delegate;
- (void)start;
- (void)stop;
@end
