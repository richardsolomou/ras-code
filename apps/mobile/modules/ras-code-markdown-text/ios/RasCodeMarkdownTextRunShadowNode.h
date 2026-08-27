#pragma once

#include <react/renderer/components/RasCodeMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/RasCodeMarkdownTextSpec/Props.h>
#include <react/renderer/components/RasCodeMarkdownTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char RasCodeMarkdownTextRunComponentName[];

using RasCodeMarkdownTextRunShadowNode = ConcreteViewShadowNode<
    RasCodeMarkdownTextRunComponentName,
    RasCodeMarkdownTextRunProps,
    RasCodeMarkdownTextRunEventEmitter,
    RasCodeMarkdownTextRunState>;
}
