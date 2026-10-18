import * as Cesium from 'cesium';
import type { Vec3 } from '../simulation/trajectory';

const scratchMatrix = new Cesium.Matrix3();
const scratchCart = new Cesium.Cartesian3();

/** JulianDate <-> unix seconds. Anchored to a reference so the conversion stays exact. */
export class TimeBridge {
  private readonly epochJd: Cesium.JulianDate;
  private readonly epochUnix: number;
  private readonly scratch = new Cesium.JulianDate();

  constructor(epochUnix: number) {
    this.epochUnix = epochUnix;
    this.epochJd = Cesium.JulianDate.fromDate(new Date(epochUnix * 1000));
  }

  toUnix(jd: Cesium.JulianDate): number {
    return this.epochUnix + Cesium.JulianDate.secondsDifference(jd, this.epochJd);
  }

  toJulian(unix: number, result?: Cesium.JulianDate): Cesium.JulianDate {
    return Cesium.JulianDate.addSeconds(this.epochJd, unix - this.epochUnix, result ?? this.scratch);
  }
}

const EARTH_ROTATION = new Cesium.Cartesian3(0, 0, 7.2921159e-5);
const scratchOmegaR = new Cesium.Cartesian3();

/** The TEME -> Earth-fixed rotation at `time` (the inertial frame the simulation's states are given in). */
export function temeToFixedMatrix(time: Cesium.JulianDate, result?: Cesium.Matrix3): Cesium.Matrix3 {
  return Cesium.Transforms.computeTemeToPseudoFixedMatrix(time, result ?? new Cesium.Matrix3());
}

/** Rotate a TEME velocity (km/s) into the Earth-fixed frame (m/s), including the -omega x r term. */
export function temeVelocityToFixed(time: Cesium.JulianDate, v: Vec3, positionFixed: Cesium.Cartesian3, result?: Cesium.Cartesian3): Cesium.Cartesian3 {
  const m = Cesium.Transforms.computeTemeToPseudoFixedMatrix(time, scratchMatrix);
  scratchCart.x = v[0] * 1000;
  scratchCart.y = v[1] * 1000;
  scratchCart.z = v[2] * 1000;
  const out = Cesium.Matrix3.multiplyByVector(m, scratchCart, result ?? new Cesium.Cartesian3());
  Cesium.Cartesian3.cross(EARTH_ROTATION, positionFixed, scratchOmegaR);
  return Cesium.Cartesian3.subtract(out, scratchOmegaR, out);
}

/**
 * Rotate a TEME position (km) into Cesium's Earth-fixed frame (metres) at the
 * given time. Uses Cesium's TEME -> pseudo-fixed matrix (GMST rotation).
 */
export function temeToFixed(time: Cesium.JulianDate, p: Vec3, result?: Cesium.Cartesian3): Cesium.Cartesian3 {
  const m = Cesium.Transforms.computeTemeToPseudoFixedMatrix(time, scratchMatrix);
  scratchCart.x = p[0] * 1000;
  scratchCart.y = p[1] * 1000;
  scratchCart.z = p[2] * 1000;
  return Cesium.Matrix3.multiplyByVector(m, scratchCart, result ?? new Cesium.Cartesian3());
}
