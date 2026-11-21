#import <Foundation/Foundation.h>

@class SDConnection;

@protocol SDConnectionDelegate <NSObject>
// Called on the connection's own reading thread (not the main thread).
- (void)connection:(SDConnection *)connection didReceiveMessage:(uint8_t)type payload:(NSData *)payload;
// Main thread.
- (void)connectionDidConnect:(SDConnection *)connection;
// Main thread. error is nil when -close was called.
- (void)connection:(SDConnection *)connection didCloseWithError:(NSString *)error;
@end

// A plain TCP connection speaking the Sandroid protocol.
@interface SDConnection : NSObject

- (instancetype)initWithHost:(NSString *)host port:(uint16_t)port;

@property (nonatomic, weak) id<SDConnectionDelegate> delegate;
@property (nonatomic, readonly) NSString *host;
@property (nonatomic, readonly) uint16_t port;
@property (atomic, readonly) BOOL connected;

- (void)connect;
- (void)close;

// Queued, in order. Safe from any thread.
- (void)send:(uint8_t)type payload:(NSData *)payload;
- (void)send:(uint8_t)type payload:(NSData *)payload completion:(void (^)(BOOL ok))completion;
- (void)sendJSON:(uint8_t)type object:(id)object;

// Blocks until written. Never call this on the main thread.
- (BOOL)sendSync:(uint8_t)type payload:(NSData *)payload;

@end
