#import <UIKit/UIKit.h>

// An invisible view that shows the iPhone keyboard and passes everything typed to Android.
@interface SDKeyboardView : UIView <UIKeyInput>

@property (nonatomic) UITextAutocorrectionType autocorrectionType;
@property (nonatomic) UITextAutocapitalizationType autocapitalizationType;
@property (nonatomic) UITextSpellCheckingType spellCheckingType;
@property (nonatomic) UIKeyboardType keyboardType;
@property (nonatomic) UIKeyboardAppearance keyboardAppearance;
@property (nonatomic) UIReturnKeyType returnKeyType;

@property (nonatomic, copy) void (^onText)(NSString *text);
@property (nonatomic, copy) void (^onKey)(int androidKeyCode);

@end
