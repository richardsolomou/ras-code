#import "RasCodeMarkdownTextRun.h"
#import "RasCodeMarkdownText.h"
#import "RasCodeMarkdownTextRunComponentDescriptor.h"
#import <react/renderer/components/RasCodeMarkdownTextSpec/EventEmitters.h>
#import <react/renderer/components/RasCodeMarkdownTextSpec/Props.h>
#import <react/renderer/components/RasCodeMarkdownTextSpec/RCTComponentViewHelpers.h>
#import "RCTFabricComponentsPlugins.h"
#import "Utils.h"

using namespace facebook::react;

@interface RasCodeMarkdownTextRun () <RCTRasCodeMarkdownTextRunViewProtocol>

@end

@implementation RasCodeMarkdownTextRun {
  NSString * _text;
  RCTBubblingEventBlock _onPress;
  RCTBubblingEventBlock _onLongPress;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
    return concreteComponentDescriptorProvider<RasCodeMarkdownTextRunComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const RasCodeMarkdownTextRunProps>();
    _props = defaultProps;
  }
  return self;
}

- (void)updateProps:(Props::Shared const &)props oldProps:(Props::Shared const &)oldProps
{
  const auto &oldViewProps = *std::static_pointer_cast<RasCodeMarkdownTextRunProps const>(_props);
  const auto &newViewProps = *std::static_pointer_cast<RasCodeMarkdownTextRunProps const>(props);

  if (newViewProps.text != oldViewProps.text) {
    NSString *text = [NSString stringWithUTF8String:newViewProps.text.c_str()];
    _text = text;
  }

  [super updateProps:props oldProps:oldProps];
}

- (void)onPress {
  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::RasCodeMarkdownTextRunEventEmitter>(_eventEmitter)
    ->onPress(facebook::react::RasCodeMarkdownTextRunEventEmitter::OnPress{});
  }
}

- (void)onLongPress {
  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::RasCodeMarkdownTextRunEventEmitter>(_eventEmitter)
    ->onLongPress(facebook::react::RasCodeMarkdownTextRunEventEmitter::OnLongPress{});
  }
}

+ (BOOL)shouldBeRecycled {
  return NO;
}

Class<RCTComponentViewProtocol> RasCodeMarkdownTextRunCls(void)
{
    return RasCodeMarkdownTextRun.class;
}

@end
