require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'RasCodeTerminalNative'
  s.version = package['version']
  s.summary = 'Native terminal surface for RAS Code mobile.'
  s.description = 'Native terminal surface bridge used by the RAS Code React Native app.'
  s.homepage = 'https://github.com/richardsolomou/ras-code'
  s.license = { :type => 'UNLICENSED' }
  s.author = { 'Richard Solomou' => 'richard@solomou.io' }
  s.platforms = { :ios => '16.1' }
  s.source = { :path => '.' }
  s.source_files = 'ios/**/*.{h,m,mm,swift}'
  s.vendored_frameworks = 'Vendor/libghostty/GhosttyKit.xcframework'
  s.frameworks = 'IOSurface', 'Metal', 'MetalKit', 'QuartzCore', 'UIKit'
  s.libraries = 'c++', 'z'
  s.swift_version = '5.9'
  s.dependency 'ExpoModulesCore'
end
