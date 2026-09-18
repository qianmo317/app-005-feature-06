import { configureStore, createSlice, PayloadAction, combineReducers } from '@reduxjs/toolkit';
import { storage } from '../utils/storage';
import type {
  Customer,
  SkinAnalysis,
  Allergy,
  Membership,
  Service,
  Package,
  PackageItem,
  Employee,
  Appointment,
  ServiceRecord,
  Schedule,
  Review,
  Attendance,
  Commission,
  WaitList
} from '../types';
import {
  mockCustomers,
  mockSkinAnalyses,
  mockAllergies,
  mockMemberships,
  mockServices,
  mockPackages,
  mockPackageItems,
  mockEmployees,
  mockAppointments,
  mockServiceRecords,
  mockSchedules,
  mockReviews,
  mockAttendance,
  mockCommissions,
  mockWaitList
} from '../mock';
import { formatDate, generateId } from '../utils/format';

// 需要考勤的岗位：美容师与技师
const ATTENDANCE_ROLES = ['beautician', 'technician'];

// 同一天同一个人只保留一条考勤
const dedupeAttendance = (records: Attendance[]): Attendance[] => {
  const seen = new Set<string>();
  return records.filter((r) => {
    const key = `${r.employeeId}_${r.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

// 为指定日期当班（非休息）的美容师/技师各生成一条考勤，已存在的跳过
const ensureAttendanceForDate = (state: AppState, dateStr: string) => {
  const today = formatDate(new Date());
  state.schedules
    .filter((s) => s.date === dateStr && s.shiftType !== 'off')
    .forEach((s) => {
      const employee = state.employees.find((e) => e.id === s.employeeId);
      if (!employee || employee.status !== 'active' || !ATTENDANCE_ROLES.includes(employee.role)) return;
      const exists = state.attendance.some((a) => a.employeeId === s.employeeId && a.date === dateStr);
      if (!exists) {
        state.attendance.unshift({
          id: generateId(),
          employeeId: s.employeeId,
          date: dateStr,
          checkIn: '--',
          checkOut: '--',
          status: dateStr < today ? 'absent' : 'pending'
        });
      }
    });
};

interface AppState {
  customers: Customer[];
  skinAnalyses: SkinAnalysis[];
  allergies: Allergy[];
  memberships: Membership[];
  services: Service[];
  packages: Package[];
  packageItems: PackageItem[];
  employees: Employee[];
  appointments: Appointment[];
  serviceRecords: ServiceRecord[];
  schedules: Schedule[];
  reviews: Review[];
  attendance: Attendance[];
  commissions: Commission[];
  waitList: WaitList[];
  initialized: boolean;
}

const STORAGE_KEY = 'app_state';

const loadState = (): AppState => {
  let state: AppState | null = null;
  try {
    const saved = storage.get<AppState>(STORAGE_KEY);
    if (saved && saved.initialized) {
      // Verify data integrity
      const firstCustomer = saved.customers[0];
      if (firstCustomer && firstCustomer.avatar && firstCustomer.avatar.includes('data:image/svg+xml;base64,')) {
        const b64 = firstCustomer.avatar.replace('data:image/svg+xml;base64,', '');
        try {
          atob(b64);
          state = saved;
        } catch (e) {
          console.log('Detected corrupted data, regenerating...');
          storage.clear();
        }
      }
    }
  } catch (e) {
    console.log('Loading fresh data...');
  }

  if (!state) {
    const customers = mockCustomers();
    const customerIds = customers.map(c => c.id);
    const services = mockServices() as Service[];
    const serviceIds = services.map(s => s.id);
    const employees = mockEmployees() as Employee[];
    const employeeIds = employees.map(e => e.id);
    const packages = mockPackages() as Package[];

    state = {
      customers,
      skinAnalyses: mockSkinAnalyses(customerIds),
      allergies: mockAllergies(customerIds),
      memberships: mockMemberships(customerIds),
      services,
      packages,
      packageItems: mockPackageItems(packages),
      employees,
      appointments: mockAppointments(customerIds, serviceIds, employeeIds),
      serviceRecords: mockServiceRecords(customerIds, serviceIds, employeeIds),
      schedules: mockSchedules(employeeIds),
      reviews: mockReviews(customerIds, employeeIds, serviceIds),
      attendance: mockAttendance(employeeIds),
      commissions: mockCommissions(employeeIds),
      waitList: mockWaitList(customerIds, serviceIds),
      initialized: true
    };
  }

  // 考勤数据规整：同人同日去重，并为当天当班的美容师/技师生成考勤
  state.attendance = dedupeAttendance(state.attendance);
  ensureAttendanceForDate(state, formatDate(new Date()));
  storage.set(STORAGE_KEY, state);
  return state;
};

const initialState: AppState = loadState();

const saveState = (state: AppState) => {
  storage.set(STORAGE_KEY, state);
};

const appSlice = createSlice({
  name: 'app',
  initialState,
  reducers: {
    addCustomer: (state, action: PayloadAction<Customer>) => {
      state.customers.unshift(action.payload);
      saveState(state);
    },
    updateCustomer: (state, action: PayloadAction<Customer>) => {
      const index = state.customers.findIndex(c => c.id === action.payload.id);
      if (index !== -1) {
        state.customers[index] = action.payload;
        saveState(state);
      }
    },
    deleteCustomer: (state, action: PayloadAction<string>) => {
      state.customers = state.customers.filter(c => c.id !== action.payload);
      saveState(state);
    },
    addSkinAnalysis: (state, action: PayloadAction<SkinAnalysis>) => {
      state.skinAnalyses.unshift(action.payload);
      saveState(state);
    },
    addAllergy: (state, action: PayloadAction<Allergy>) => {
      state.allergies.unshift(action.payload);
      saveState(state);
    },
    updateAllergy: (state, action: PayloadAction<Allergy>) => {
      const index = state.allergies.findIndex(a => a.id === action.payload.id);
      if (index !== -1) {
        state.allergies[index] = action.payload;
        saveState(state);
      }
    },
    deleteAllergy: (state, action: PayloadAction<string>) => {
      state.allergies = state.allergies.filter(a => a.id !== action.payload);
      saveState(state);
    },
    addService: (state, action: PayloadAction<Service>) => {
      state.services.unshift(action.payload);
      saveState(state);
    },
    updateService: (state, action: PayloadAction<Service>) => {
      const index = state.services.findIndex(s => s.id === action.payload.id);
      if (index !== -1) {
        state.services[index] = action.payload;
        saveState(state);
      }
    },
    deleteService: (state, action: PayloadAction<string>) => {
      state.services = state.services.filter(s => s.id !== action.payload);
      saveState(state);
    },
    addPackage: (state, action: PayloadAction<Package>) => {
      state.packages.unshift(action.payload);
      saveState(state);
    },
    updatePackage: (state, action: PayloadAction<Package>) => {
      const index = state.packages.findIndex(p => p.id === action.payload.id);
      if (index !== -1) {
        state.packages[index] = action.payload;
        saveState(state);
      }
    },
    addAppointment: (state, action: PayloadAction<Appointment>) => {
      state.appointments.unshift(action.payload);
      saveState(state);
    },
    updateAppointment: (state, action: PayloadAction<Appointment>) => {
      const index = state.appointments.findIndex(a => a.id === action.payload.id);
      if (index !== -1) {
        state.appointments[index] = action.payload;
        saveState(state);
      }
    },
    deleteAppointment: (state, action: PayloadAction<string>) => {
      state.appointments = state.appointments.filter(a => a.id !== action.payload);
      saveState(state);
    },
    addEmployee: (state, action: PayloadAction<Employee>) => {
      state.employees.unshift(action.payload);
      saveState(state);
    },
    updateEmployee: (state, action: PayloadAction<Employee>) => {
      const index = state.employees.findIndex(e => e.id === action.payload.id);
      if (index !== -1) {
        state.employees[index] = action.payload;
        saveState(state);
      }
    },
    updateSchedule: (state, action: PayloadAction<Schedule>) => {
      const index = state.schedules.findIndex(s => s.id === action.payload.id);
      if (index !== -1) {
        state.schedules[index] = action.payload;
      } else {
        state.schedules.push(action.payload);
      }
      saveState(state);
    },
    generateDailyAttendance: (state, action: PayloadAction<string>) => {
      ensureAttendanceForDate(state, action.payload);
      saveState(state);
    },
    // 补打卡/改状态共用：按员工+日期唯一，存在则覆盖，否则新增
    upsertAttendance: (state, action: PayloadAction<Attendance>) => {
      const index = state.attendance.findIndex(
        a => a.employeeId === action.payload.employeeId && a.date === action.payload.date
      );
      if (index !== -1) {
        state.attendance[index] = { ...action.payload, id: state.attendance[index].id };
      } else {
        state.attendance.unshift(action.payload);
      }
      saveState(state);
    },
    reviewAttendance: (state, action: PayloadAction<{ id: string; reviewer: string }>) => {
      const record = state.attendance.find(a => a.id === action.payload.id);
      if (record) {
        record.reviewStatus = 'approved';
        record.updatedBy = action.payload.reviewer;
        record.updatedAt = new Date().toISOString();
        saveState(state);
      }
    },
    addWaitList: (state, action: PayloadAction<WaitList>) => {
      state.waitList.unshift(action.payload);
      saveState(state);
    },
    updateWaitList: (state, action: PayloadAction<WaitList>) => {
      const index = state.waitList.findIndex(w => w.id === action.payload.id);
      if (index !== -1) {
        state.waitList[index] = action.payload;
        saveState(state);
      }
    },
    deleteWaitList: (state, action: PayloadAction<string>) => {
      state.waitList = state.waitList.filter(w => w.id !== action.payload);
      saveState(state);
    },
    addServiceRecord: (state, action: PayloadAction<ServiceRecord>) => {
      state.serviceRecords.unshift(action.payload);
      const membership = state.memberships.find(m => m.customerId === action.payload.customerId);
      if (membership) {
        membership.totalSpent += action.payload.price;
        membership.points += Math.floor(action.payload.price / 10);
        if (membership.totalSpent > 30000) membership.level = 'diamond';
        else if (membership.totalSpent > 20000) membership.level = 'platinum';
        else if (membership.totalSpent > 10000) membership.level = 'gold';
        else if (membership.totalSpent > 5000) membership.level = 'silver';
      }
      saveState(state);
    }
  }
});

export const {
  addCustomer,
  updateCustomer,
  deleteCustomer,
  addSkinAnalysis,
  addAllergy,
  updateAllergy,
  deleteAllergy,
  addService,
  updateService,
  deleteService,
  addPackage,
  updatePackage,
  addAppointment,
  updateAppointment,
  deleteAppointment,
  addEmployee,
  updateEmployee,
  updateSchedule,
  generateDailyAttendance,
  upsertAttendance,
  reviewAttendance,
  addWaitList,
  updateWaitList,
  deleteWaitList,
  addServiceRecord
} = appSlice.actions;

export const store = configureStore({
  reducer: {
    app: appSlice.reducer
  }
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
