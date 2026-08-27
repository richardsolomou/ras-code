#pragma once

#include "RasCodeMarkdownTextRunShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using RasCodeMarkdownTextRunComponentDescriptor = ConcreteComponentDescriptor<RasCodeMarkdownTextRunShadowNode>;

void RasCodeMarkdownTextRunSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
