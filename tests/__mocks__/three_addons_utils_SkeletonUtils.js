// Mock for three/addons/utils/SkeletonUtils.js
export function clone(source) {
  // Return a simple copy that mimics the cloned structure
  const { Group } = require('./three.js');
  const cloned = new Group();
  cloned.rotation = { x: 0, y: 0, z: 0 };
  return cloned;
}
