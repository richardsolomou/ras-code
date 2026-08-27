#import <React/RCTViewManager.h>
#import <React/RCTUIManager.h>
#import "RCTBridge.h"
#import "Utils.h"

@interface RasCodeMarkdownTextManager : RCTViewManager
@end

@implementation RasCodeMarkdownTextManager

RCT_EXPORT_MODULE(RasCodeMarkdownText)

- (UIView *)view
{
  return [[UIView alloc] init];
}

RCT_CUSTOM_VIEW_PROPERTY(color, NSString, UIView)
{
}

@end

@interface RasCodeMarkdownTextRunManager : RCTViewManager
@end

@implementation RasCodeMarkdownTextRunManager

RCT_EXPORT_MODULE(RasCodeMarkdownTextRun)

- (UIView *)view
{
  return nil;
}

@end
