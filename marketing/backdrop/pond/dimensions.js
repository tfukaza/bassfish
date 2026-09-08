export const POND_SIDE = 8.8;
export const POND_HALF = POND_SIDE / 2;
// Reposition the existing layout from its original eight-unit depth.
// Object geometry stays at its original proportions.
export const DEPTH_SCALE = POND_SIDE / 8;
export const layoutZ = z => z * DEPTH_SCALE;
