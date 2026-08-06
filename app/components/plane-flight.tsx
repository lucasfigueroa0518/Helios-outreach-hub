'use client';

const HUB_FLIGHT_SECONDS = 3.5;
const HUB_PAUSE_SECONDS = 3.5;
const DRAFTING_FLIGHT_SECONDS = 4.8;
const DRAFTING_PAUSE_SECONDS = 3.2;
const MIN_SPEED_RATIO = 0.86;

function parabolicPathFraction(t: number): number {
  const integral = (tau: number) =>
    MIN_SPEED_RATIO * tau
    + (1 - MIN_SPEED_RATIO) * 4 * ((tau ** 3) / 3 - (tau ** 2) / 2 + 0.25 * tau);
  return integral(t) / integral(1);
}

export function buildFlightKeyframes(
  flightSeconds: number,
  pauseSeconds: number,
  steps = 17,
) {
  const cycleSeconds = flightSeconds + pauseSeconds;
  const flightEnd = flightSeconds / cycleSeconds;

  const keyTimes: number[] = [];
  const keyPoints: number[] = [];
  const trailMain: number[] = [];
  const trailSoft: number[] = [];

  for (let i = 0; i < steps; i += 1) {
    const t = i / (steps - 1);
    const pathFraction = parabolicPathFraction(t);
    keyTimes.push(t * flightEnd);
    keyPoints.push(pathFraction);
    trailMain.push(36 - 1000 * pathFraction);
    trailSoft.push(60 - 1000 * pathFraction);
  }

  keyTimes.push(1);
  keyPoints.push(1);
  trailMain.push(-964);
  trailSoft.push(-940);

  const join = (values: number[]) => values.map((v) => v.toFixed(3)).join(';');

  return {
    keyTimes: join(keyTimes),
    keyPoints: join(keyPoints),
    trailMain: join(trailMain),
    trailSoft: join(trailSoft),
    cycleDur: `${cycleSeconds}s`,
    flightEnd,
  };
}

export function buildParabolicKeyframes(steps = 17) {
  return buildFlightKeyframes(HUB_FLIGHT_SECONDS, HUB_PAUSE_SECONDS, steps);
}

function PlaneBody() {
  return (
    <g className="plane-flight__plane-body">
      <path className="plane-flight__wing plane-flight__wing--left" d="M 16,0 L -14,-10 L -8,0 Z" />
      <path className="plane-flight__wing plane-flight__wing--right" d="M 16,0 L -8,0 L -14,10 Z" />
      <path className="plane-flight__keel" d="M -8,0 L -14,10 L -11,3 Z" />
    </g>
  );
}

type PlaneFlightProps = {
  className?: string;
  viewBox?: string;
  path: string;
  flightSeconds?: number;
  pauseSeconds?: number;
  /** 0–1 cycle fraction where this layer becomes visible */
  showFrom?: number;
  /** 0–1 cycle fraction where this layer hides */
  showUntil?: number;
  showTrail?: boolean;
  /** Peak opacity for the plane body (0–1) */
  planePeakOpacity?: number;
  /** Peak opacity for the main trail stroke (0–1) */
  trailPeakOpacity?: number;
  /** Peak opacity for the soft trail stroke (0–1) */
  trailSoftPeakOpacity?: number;
};

export function PlaneFlight({
  className = 'plane-flight',
  viewBox = '0 0 1200 360',
  path,
  flightSeconds = HUB_FLIGHT_SECONDS,
  pauseSeconds = HUB_PAUSE_SECONDS,
  showFrom = 0,
  showUntil,
  showTrail = true,
  planePeakOpacity = 1,
  trailPeakOpacity = 0.22,
  trailSoftPeakOpacity = 0.1,
}: PlaneFlightProps) {
  const frames = buildFlightKeyframes(flightSeconds, pauseSeconds);
  const flightEnd = frames.flightEnd;
  const fadeIn = showFrom.toFixed(3);
  const fadeOut = (showUntil ?? flightEnd).toFixed(3);
  const opacityKeyTimes = `0;${fadeIn};${fadeOut};${flightEnd.toFixed(3)};1`;
  const planeOpacityValues = `0;${planePeakOpacity};${planePeakOpacity};0;0`;
  const trailOpacityValues = `0;${trailPeakOpacity};${trailPeakOpacity};0;0`;
  const trailSoftOpacityValues = `0;${trailSoftPeakOpacity};${trailSoftPeakOpacity};0;0`;

  return (
    <svg className={className} viewBox={viewBox} preserveAspectRatio="none" aria-hidden="true">
      {showTrail ? (
        <>
          <path className="plane-flight__trail plane-flight__trail--soft" d={path} pathLength="1000">
            <animate
              attributeName="stroke-dashoffset"
              values={frames.trailSoft}
              dur={frames.cycleDur}
              repeatCount="indefinite"
              keyTimes={frames.keyTimes}
              calcMode="linear"
            />
            <animate attributeName="opacity" values={trailSoftOpacityValues} keyTimes={opacityKeyTimes} dur={frames.cycleDur} repeatCount="indefinite" />
          </path>
          <path className="plane-flight__trail" d={path} pathLength="1000">
            <animate
              attributeName="stroke-dashoffset"
              values={frames.trailMain}
              dur={frames.cycleDur}
              repeatCount="indefinite"
              keyTimes={frames.keyTimes}
              calcMode="linear"
            />
            <animate attributeName="opacity" values={trailOpacityValues} keyTimes={opacityKeyTimes} dur={frames.cycleDur} repeatCount="indefinite" />
          </path>
        </>
      ) : null}
      <g className="plane-flight__plane">
        <PlaneBody />
        <animate attributeName="opacity" values={planeOpacityValues} keyTimes={opacityKeyTimes} dur={frames.cycleDur} repeatCount="indefinite" />
        <animateMotion
          dur={frames.cycleDur}
          repeatCount="indefinite"
          rotate="auto"
          path={path}
          keyPoints={frames.keyPoints}
          keyTimes={frames.keyTimes}
          calcMode="linear"
        />
      </g>
    </svg>
  );
}

/** Hub overview arc — horizontal flight with loop-de-loop */
export function HubPlaneFlight() {
  const path =
    'M-50 200 C120 192 220 184 300 178 C340 175 375 138 360 114 C345 90 312 98 304 130 C296 162 318 184 360 178 C440 172 620 210 950 260';
  return <PlaneFlight className="hub-plane-flight plane-flight" viewBox="0 0 1200 360" path={path} />;
}

/**
 * Drafting status strip: loops inside the status card, clipped to its edges,
 * always behind all text/tiles/bars, then exits off the right edge.
 */
export function DraftingProgressPlane() {
  const path =
    'M 872 188'
    + ' C 858 162 828 108 738 82'
    + ' C 648 56 520 46 390 50'
    + ' C 260 54 178 70 145 92'
    + ' C 112 114 108 136 128 154'
    + ' C 148 172 192 182 250 176'
    + ' C 308 170 400 148 500 124'
    + ' C 600 100 720 84 840 80'
    + ' C 960 76 1060 92 1130 112'
    + ' C 1165 122 1190 136 1210 152';

  return (
    <div className="drafting-strip-plane" aria-hidden="true">
      <PlaneFlight
        className="drafting-plane-flight plane-flight"
        viewBox="0 0 1220 220"
        path={path}
        flightSeconds={DRAFTING_FLIGHT_SECONDS}
        pauseSeconds={DRAFTING_PAUSE_SECONDS}
        showFrom={0.01}
        showUntil={0.58}
        planePeakOpacity={0.62}
        trailPeakOpacity={0.11}
        trailSoftPeakOpacity={0.05}
      />
    </div>
  );
}
