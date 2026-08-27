#pragma once

#include "RasCodeMarkdownTextShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using RasCodeMarkdownTextComponentDescriptor = ConcreteComponentDescriptor<RasCodeMarkdownTextShadowNode>;

void RasCodeMarkdownTextSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
