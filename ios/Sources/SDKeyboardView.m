#import "SDKeyboardView.h"
#import "SDProtocol.h"

@implementation SDKeyboardView {
    UIToolbar *_accessory;
}

- (instancetype)initWithFrame:(CGRect)frame {
    if ((self = [super initWithFrame:frame])) {
        _autocorrectionType = UITextAutocorrectionTypeNo;
        _autocapitalizationType = UITextAutocapitalizationTypeNone;
        _spellCheckingType = UITextSpellCheckingTypeNo;
        _keyboardType = UIKeyboardTypeDefault;
        _keyboardAppearance = UIKeyboardAppearanceDark;
        _returnKeyType = UIReturnKeyDefault;
        self.userInteractionEnabled = NO;
    }
    return self;
}

- (BOOL)canBecomeFirstResponder {
    return YES;
}

- (BOOL)hasText {
    return YES;  // so the delete key always works
}

- (void)insertText:(NSString *)text {
    if ([text isEqualToString:@"\n"]) {
        if (self.onKey) self.onKey(SDKeyEnter);
    } else if ([text isEqualToString:@"\t"]) {
        if (self.onKey) self.onKey(SDKeyTab);
    } else if (text.length) {
        if (self.onText) self.onText(text);
    }
}

- (void)deleteBackward {
    if (self.onKey) self.onKey(SDKeyDel);
}

- (UIBarButtonItem *)item:(NSString *)title key:(int)key {
    UIBarButtonItem *b = [[UIBarButtonItem alloc] initWithTitle:title style:UIBarButtonItemStylePlain target:self action:@selector(keyButton:)];
    b.tag = key;
    return b;
}

- (UIView *)inputAccessoryView {
    if (!_accessory) {
        _accessory = [[UIToolbar alloc] initWithFrame:CGRectMake(0, 0, 320, 44)];
        _accessory.barStyle = UIBarStyleBlack;
        _accessory.translucent = YES;
        UIBarButtonItem *flex = [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemFlexibleSpace target:nil action:nil];
        UIBarButtonItem *done = [[UIBarButtonItem alloc] initWithTitle:@"Hide" style:UIBarButtonItemStyleDone target:self action:@selector(hide)];
        _accessory.items = @[
            [self item:@"Esc" key:SDKeyEscape], [self item:@"Tab" key:SDKeyTab], flex, [self item:@"←" key:SDKeyDpadLeft],
            [self item:@"↑" key:SDKeyDpadUp], [self item:@"↓" key:SDKeyDpadDown], [self item:@"→" key:SDKeyDpadRight], flex, done
        ];
    }
    return _accessory;
}

- (void)keyButton:(UIBarButtonItem *)sender {
    if (self.onKey) self.onKey((int)sender.tag);
}

- (void)hide {
    [self resignFirstResponder];
}

@end
