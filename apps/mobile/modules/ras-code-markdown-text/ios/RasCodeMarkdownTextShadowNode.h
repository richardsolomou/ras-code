#pragma once

#include <react/renderer/components/RasCodeMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/RasCodeMarkdownTextSpec/Props.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/textlayoutmanager/TextLayoutManager.h>
#include <react/renderer/core/LayoutContext.h>
#include <react/renderer/core/ShadowNode.h>

#include <string>
#include <vector>

namespace facebook::react {

extern const char RasCodeMarkdownTextComponentName[];

struct RasCodeMarkdownTextParagraphStyleRange {
  size_t location;
  size_t length;
  Float firstLineHeadIndent;
  Float headIndent;
  Float paragraphSpacing;
};

struct RasCodeMarkdownTextAttachmentRange {
  size_t location;
  size_t length;
  std::string imageUri;
};

inline Float RasCodeMarkdownTextAttachmentSize(const RasCodeMarkdownTextAttachmentRange &) {
  return 14;
}

inline Float RasCodeMarkdownTextAttachmentBaselineOffset(
    const RasCodeMarkdownTextAttachmentRange &) {
  return -2;
}

class RasCodeMarkdownTextStateReal final {
 public:
  AttributedString attributedString;
  std::vector<RasCodeMarkdownTextParagraphStyleRange> paragraphStyleRanges;
  std::vector<RasCodeMarkdownTextAttachmentRange> attachmentRanges;
};

class RasCodeMarkdownTextShadowNode final : public ConcreteViewShadowNode<
RasCodeMarkdownTextComponentName,
RasCodeMarkdownTextProps,
RasCodeMarkdownTextEventEmitter,
RasCodeMarkdownTextStateReal> {
public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  RasCodeMarkdownTextShadowNode(
   const ShadowNode& sourceShadowNode,
   const ShadowNodeFragment& fragment
  );

  static ShadowNodeTraits BaseTraits() {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  void layout(LayoutContext layoutContext) override;

  Size measureContent(
      const LayoutContext& layoutContext,
      const LayoutConstraints& layoutConstraints) const override;

private:
  mutable AttributedString _attributedString;
  mutable std::vector<RasCodeMarkdownTextParagraphStyleRange> _paragraphStyleRanges;
  mutable std::vector<RasCodeMarkdownTextAttachmentRange> _attachmentRanges;
};
} // namespace facebook::React
