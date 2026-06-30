// Sleep data types
export interface SleepMetric {
  date: string;
  source: string;
  inBedStart: string;
  inBedEnd: string;
  sleepStart: string;
  sleepEnd: string;
  awake: number;
  rem: number;
  deep: number;
  core: number;
  asleep: number;
  inBed: number;
}

export interface SleepDataPayload {
  data: {
    metrics: Array<{
      data: SleepMetric[];
    }>;
  };
}

// Mindful minutes / Meditation types
export interface MindfulMinutesMetric {
  date: string;
  source?: string;
  qty: number;
}

export interface MindfulMinutesDataPayload {
  data: {
    metrics: Array<{
      data: MindfulMinutesMetric[];
    }>;
  };
}

// Workout types
export interface Workout {
  id: string;
  name: string;
  location: string;
  isIndoor?: boolean;
  start: string;
  end: string;
  duration: number;
  distance?: {
    qty: number;
    units: string;
  };
  activeEnergyBurned?: {
    qty: number;
    units: string;
  };
  totalEnergy?: {
    qty: number;
    units: string;
  };
  intensity?: {
    qty: number;
    units: string;
  };
  avgSpeed?: {
    qty: number;
    units: string;
  };
  maxSpeed?: {
    qty: number;
    units: string;
  };
  elevationUp?: {
    qty: number;
    units: string;
  };
  elevationDown?: {
    qty: number;
    units: string;
  };
  heartRate?: {
    min?: { qty: number; units: string };
    avg?: { qty: number; units: string };
    max?: { qty: number; units: string };
  };
  stepCadence?: {
    qty: number;
    units: string;
  };
  temperature?: {
    qty: number;
    units: string;
  };
  humidity?: {
    qty: number;
    units: string;
  };
  metadata?: Record<string, any>;
}

export interface WorkoutsDataPayload {
  data: {
    workouts: Workout[];
  };
}

// HRV types
export interface HRVMetric {
  date: string;
  source?: string;
  qty: number;
}

export interface HRVDataPayload {
  data: {
    metrics: Array<{
      name?: string;
      units?: string;
      data: HRVMetric[];
    }>;
  };
}

// Respiratory rate types
export interface RespiratoryRateMetric {
  date: string;
  source?: string;
  qty: number;
}

export interface RespiratoryRateDataPayload {
  data: {
    metrics: Array<{
      name?: string;
      units?: string;
      data: RespiratoryRateMetric[];
    }>;
  };
}

// Hourly active energy types
export interface HourlyActiveEnergyMetric {
  date: string;
  source?: string;
  qty: number;
}

export interface HourlyActiveEnergyDataPayload {
  data: {
    metrics: Array<{
      data: HourlyActiveEnergyMetric[];
    }>;
  };
}
