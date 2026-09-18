import React, { useEffect, useState } from 'react';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  TimePicker,
  message
} from 'antd';
import {
  ClockCircleOutlined,
  EditOutlined,
  UserOutlined
} from '@ant-design/icons';
import { useSelector, useDispatch } from 'react-redux';
import type { RootState } from '../../store';
import { generateDailyAttendance, reviewAttendance, upsertAttendance } from '../../store';
import type { Attendance, Employee, Schedule } from '../../types';
import {
  generateId,
  getAttendanceStatusColor,
  getAttendanceStatusText,
  getStatusText
} from '../../utils/format';
import dayjs from 'dayjs';

// 每人每月补打卡超过该次数后，需要管理员审核
const MAKEUP_REVIEW_THRESHOLD = 3;
const ATTENDANCE_ROLES = ['beautician', 'technician'];

// 把 'HH:mm' 转成当天的 dayjs 时间，用于回显 TimePicker
const parseTime = (time: string) => {
  const [hour, minute] = time.split(':').map(Number);
  return dayjs().hour(hour).minute(minute).second(0);
};

interface DayRow {
  employee: Employee;
  schedule?: Schedule;
  record?: Attendance;
}

const AttendancePage: React.FC = () => {
  const dispatch = useDispatch();
  const state = useSelector((state: RootState) => state.app);
  const [selectedDate, setSelectedDate] = useState(dayjs());
  const [selectedMonth, setSelectedMonth] = useState(dayjs());
  const [target, setTarget] = useState<DayRow | null>(null);
  const [targetDate, setTargetDate] = useState('');
  const [modalMode, setModalMode] = useState<'makeup' | 'status' | null>(null);
  const [makeupForm] = Form.useForm();
  const [statusForm] = Form.useForm();

  const todayStr = dayjs().format('YYYY-MM-DD');
  const dateStr = selectedDate.format('YYYY-MM-DD');

  // 查看的日期不超过今天时，自动为当天当班的美容师/技师各生成一条考勤
  useEffect(() => {
    if (dateStr <= todayStr) {
      dispatch(generateDailyAttendance(dateStr));
    }
  }, [dateStr, todayStr, dispatch]);

  const attendantEmployees = state.employees.filter(
    (e) => e.status === 'active' && ATTENDANCE_ROLES.includes(e.role)
  );

  const dayRows: DayRow[] = attendantEmployees
    .map((employee) => ({
      employee,
      schedule: state.schedules.find((s) => s.employeeId === employee.id && s.date === dateStr),
      record: state.attendance.find((a) => a.employeeId === employee.id && a.date === dateStr)
    }))
    .filter((row) => row.schedule || row.record);

  // 考勤与当天班次对不上的情况，统一提醒
  const dayAlerts: string[] = [];
  dayRows.forEach(({ employee, schedule, record }) => {
    const working = schedule && schedule.shiftType !== 'off';
    if (working && !record) {
      dayAlerts.push(`${employee.name} 当天排班为「${getStatusText(schedule.shiftType)}」，但缺少考勤记录`);
    } else if (working && record) {
      if (record.status === 'absent') {
        dayAlerts.push(`${employee.name} 排班为「${getStatusText(schedule.shiftType)}」，考勤为缺勤，请确认是否漏打卡`);
      }
      if (
        record.status === 'present' &&
        schedule.startTime !== '--' &&
        record.checkIn !== '--' &&
        record.checkIn > schedule.startTime
      ) {
        dayAlerts.push(`${employee.name} 签到 ${record.checkIn} 晚于班次开始 ${schedule.startTime}，状态仍为出勤`);
      }
    }
    if (!working && record && (record.status === 'present' || record.status === 'late')) {
      dayAlerts.push(
        `${employee.name} 当天${schedule ? '排班为休息' : '未排班'}，但存在${getAttendanceStatusText(record.status)}记录`
      );
    }
  });

  const isCrossMonth = targetDate.slice(0, 7) !== dayjs().format('YYYY-MM');

  const openMakeup = (row: DayRow) => {
    setTarget(row);
    setTargetDate(dateStr);
    setModalMode('makeup');
    makeupForm.setFieldsValue({
      checkIn: row.record && row.record.checkIn !== '--' ? parseTime(row.record.checkIn) : null,
      checkOut: row.record && row.record.checkOut !== '--' ? parseTime(row.record.checkOut) : null,
      operator: '管理员',
      note: row.record?.note || ''
    });
  };

  const openStatus = (row: DayRow) => {
    setTarget(row);
    setTargetDate(dateStr);
    setModalMode('status');
    statusForm.setFieldsValue({
      status: row.record && row.record.status !== 'pending' ? row.record.status : 'present',
      operator: '管理员',
      note: row.record?.note || ''
    });
  };

  const handleMakeupSubmit = async () => {
    if (!target) return;
    try {
      const values = await makeupForm.validateFields();
      const { employee, schedule, record } = target;
      const checkIn = values.checkIn.format('HH:mm') as string;
      const checkOut = values.checkOut ? (values.checkOut.format('HH:mm') as string) : '--';
      // 签到晚于班次开始时间自动记为迟到
      let status: Attendance['status'] = 'present';
      if (schedule && schedule.shiftType !== 'off' && schedule.startTime !== '--' && checkIn > schedule.startTime) {
        status = 'late';
      }
      const monthKey = targetDate.slice(0, 7);
      // 统计本月补卡次数（不含当前这条，避免重复编辑同一条被重复计数）
      const makeupCount =
        state.attendance.filter(
          (a) => a.employeeId === employee.id && a.date.startsWith(monthKey) && a.makeup && a.id !== record?.id
        ).length + 1;
      const needReview = makeupCount > MAKEUP_REVIEW_THRESHOLD;
      dispatch(
        upsertAttendance({
          id: record?.id || generateId(),
          employeeId: employee.id,
          date: targetDate,
          checkIn,
          checkOut,
          status,
          makeup: true,
          note: values.note || undefined,
          reviewStatus: needReview ? 'pending' : record?.reviewStatus,
          updatedBy: values.operator,
          updatedAt: new Date().toISOString()
        })
      );
      if (needReview) {
        message.warning(`该员工本月第 ${makeupCount} 次补卡，超过 ${MAKEUP_REVIEW_THRESHOLD} 次，需管理员审核`);
      } else {
        message.success(status === 'late' ? '补打卡成功，已按班次记为迟到' : '补打卡成功');
      }
      setModalMode(null);
    } catch {
      // validation error
    }
  };

  const handleStatusSubmit = async () => {
    if (!target) return;
    try {
      const values = await statusForm.validateFields();
      const { employee, record } = target;
      const offDuty = values.status === 'leave' || values.status === 'absent';
      dispatch(
        upsertAttendance({
          id: record?.id || generateId(),
          employeeId: employee.id,
          date: targetDate,
          checkIn: offDuty ? '--' : record?.checkIn || '--',
          checkOut: offDuty ? '--' : record?.checkOut || '--',
          status: values.status,
          makeup: record?.makeup,
          note: values.note || record?.note,
          reviewStatus: record?.reviewStatus,
          updatedBy: values.operator,
          updatedAt: new Date().toISOString()
        })
      );
      message.success('考勤状态已更新');
      setModalMode(null);
    } catch {
      // validation error
    }
  };

  const monthKey = selectedMonth.format('YYYY-MM');
  const summaryRows = attendantEmployees.map((employee) => {
    const records = state.attendance.filter(
      (a) => a.employeeId === employee.id && a.date.startsWith(monthKey)
    );
    const count = (status: string) => records.filter((r) => r.status === status).length;
    return {
      key: employee.id,
      employee,
      present: count('present'),
      late: count('late'),
      leave: count('leave'),
      absent: count('absent'),
      pending: count('pending'),
      makeup: records.filter((r) => r.makeup).length,
      pendingReview: records.filter((r) => r.reviewStatus === 'pending').length
    };
  });

  const reviewList = state.attendance
    .filter((a) => a.reviewStatus === 'pending')
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date));

  const dayColumns = [
    {
      title: '员工',
      key: 'employee',
      render: (_: unknown, row: DayRow) => (
        <Space>
          <Avatar size={32} src={row.employee.avatar} icon={<UserOutlined />} />
          <span>{row.employee.name}</span>
        </Space>
      )
    },
    {
      title: '当日班次',
      key: 'schedule',
      render: (_: unknown, row: DayRow) =>
        row.schedule ? (
          <Space size={4}>
            <span>{getStatusText(row.schedule.shiftType)}</span>
            {row.schedule.startTime !== '--' && (
              <span style={{ fontSize: 12, color: '#8c8c8c' }}>
                {row.schedule.startTime}-{row.schedule.endTime}
              </span>
            )}
          </Space>
        ) : (
          <Tag>未排班</Tag>
        )
    },
    {
      title: '签到',
      key: 'checkIn',
      width: 80,
      render: (_: unknown, row: DayRow) => row.record?.checkIn || '--'
    },
    {
      title: '签退',
      key: 'checkOut',
      width: 80,
      render: (_: unknown, row: DayRow) => row.record?.checkOut || '--'
    },
    {
      title: '状态',
      key: 'status',
      width: 90,
      render: (_: unknown, row: DayRow) =>
        row.record ? (
          <Tag color={getAttendanceStatusColor(row.record.status)}>
            {getAttendanceStatusText(row.record.status)}
          </Tag>
        ) : (
          <Tag>未打卡</Tag>
        )
    },
    {
      title: '补卡/审核',
      key: 'makeup',
      render: (_: unknown, row: DayRow) => (
        <Space size={4}>
          {row.record?.makeup && <Tag color="purple">补卡</Tag>}
          {row.record?.reviewStatus === 'pending' && <Tag color="orange">待审核</Tag>}
          {row.record?.reviewStatus === 'approved' && <Tag color="green">已审核</Tag>}
        </Space>
      )
    },
    {
      title: '说明',
      key: 'note',
      ellipsis: true,
      render: (_: unknown, row: DayRow) => row.record?.note || '-'
    },
    {
      title: '最近改动',
      key: 'updated',
      render: (_: unknown, row: DayRow) =>
        row.record?.updatedBy ? (
          <span style={{ fontSize: 12, color: '#8c8c8c' }}>
            {row.record.updatedBy} · {dayjs(row.record.updatedAt).format('MM-DD HH:mm')}
          </span>
        ) : (
          '-'
        )
    },
    {
      title: '操作',
      key: 'action',
      render: (_: unknown, row: DayRow) => (
        <Space>
          <Button
            type="link"
            size="small"
            icon={<ClockCircleOutlined />}
            onClick={() => openMakeup(row)}
          >
            补打卡
          </Button>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openStatus(row)}>
            改状态
          </Button>
        </Space>
      )
    }
  ];

  const summaryColumns = [
    {
      title: '员工',
      key: 'employee',
      render: (_: unknown, row: (typeof summaryRows)[number]) => (
        <Space>
          <Avatar size={32} src={row.employee.avatar} icon={<UserOutlined />} />
          <span>{row.employee.name}</span>
        </Space>
      )
    },
    { title: '出勤', dataIndex: 'present', key: 'present' },
    { title: '迟到', dataIndex: 'late', key: 'late' },
    { title: '请假', dataIndex: 'leave', key: 'leave' },
    { title: '缺勤', dataIndex: 'absent', key: 'absent' },
    { title: '待打卡', dataIndex: 'pending', key: 'pending' },
    {
      title: '补卡次数',
      dataIndex: 'makeup',
      key: 'makeup',
      render: (count: number) => (
        <span
          style={{
            color: count > MAKEUP_REVIEW_THRESHOLD ? '#cf1322' : undefined,
            fontWeight: count > MAKEUP_REVIEW_THRESHOLD ? 600 : 400
          }}
        >
          {count}
        </span>
      )
    },
    {
      title: '提醒',
      key: 'flags',
      render: (_: unknown, row: (typeof summaryRows)[number]) => (
        <Space size={4}>
          {row.makeup > MAKEUP_REVIEW_THRESHOLD && <Tag color="orange">补卡超限</Tag>}
          {row.pendingReview > 0 && <Tag color="red">{row.pendingReview} 条待审核</Tag>}
        </Space>
      )
    }
  ];

  const reviewColumns = [
    {
      title: '员工',
      key: 'employee',
      render: (_: unknown, record: Attendance) => {
        const employee = state.employees.find((e) => e.id === record.employeeId);
        return (
          <Space>
            <Avatar size={32} src={employee?.avatar} icon={<UserOutlined />} />
            <span>{employee?.name || record.employeeId}</span>
          </Space>
        );
      }
    },
    { title: '日期', dataIndex: 'date', key: 'date' },
    { title: '签到', dataIndex: 'checkIn', key: 'checkIn', width: 80 },
    { title: '签退', dataIndex: 'checkOut', key: 'checkOut', width: 80 },
    {
      title: '状态',
      key: 'status',
      render: (_: unknown, record: Attendance) => (
        <Tag color={getAttendanceStatusColor(record.status)}>
          {getAttendanceStatusText(record.status)}
        </Tag>
      )
    },
    {
      title: '说明',
      dataIndex: 'note',
      key: 'note',
      ellipsis: true,
      render: (note: string) => note || '-'
    },
    {
      title: '改动人',
      dataIndex: 'updatedBy',
      key: 'updatedBy',
      render: (updatedBy: string) => updatedBy || '-'
    },
    {
      title: '操作',
      key: 'action',
      render: (_: unknown, record: Attendance) => (
        <Popconfirm
          title="确认通过该补卡记录？"
          okText="通过"
          cancelText="取消"
          onConfirm={() => {
            dispatch(reviewAttendance({ id: record.id, reviewer: '管理员' }));
            message.success('已审核通过');
          }}
        >
          <Button type="link" size="small">
            通过
          </Button>
        </Popconfirm>
      )
    }
  ];

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-header-title">考勤管理</h1>
          <p className="page-header-subtitle">
            按天生成当班考勤，支持补打卡与状态调整，每人每月补卡超过 {MAKEUP_REVIEW_THRESHOLD} 次需审核
          </p>
        </div>
      </div>

      <Card className="card-wrapper" bordered={false}>
        <Tabs
          defaultActiveKey="daily"
          items={[
            {
              key: 'daily',
              label: '每日考勤',
              children: (
                <>
                  <Space style={{ marginBottom: 16 }} wrap>
                    <DatePicker
                      value={selectedDate}
                      onChange={(date) => date && setSelectedDate(date)}
                      allowClear={false}
                    />
                    <span style={{ color: '#8c8c8c', fontSize: 13 }}>
                      已按排班为当班的美容师/技师自动生成本日考勤
                    </span>
                  </Space>
                  {dayAlerts.length > 0 && (
                    <Alert
                      type="warning"
                      showIcon
                      style={{ marginBottom: 16 }}
                      message={`考勤与班次对不上（${dayAlerts.length} 条）`}
                      description={
                        <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                          {dayAlerts.map((alert, index) => (
                            <li key={index}>{alert}</li>
                          ))}
                        </ul>
                      }
                    />
                  )}
                  <Table
                    columns={dayColumns}
                    dataSource={dayRows}
                    rowKey={(row) => row.employee.id}
                    pagination={false}
                    size="middle"
                  />
                </>
              )
            },
            {
              key: 'monthly',
              label: '月度汇总',
              children: (
                <>
                  <Space style={{ marginBottom: 16 }}>
                    <DatePicker
                      picker="month"
                      value={selectedMonth}
                      onChange={(date) => date && setSelectedMonth(date)}
                      allowClear={false}
                    />
                  </Space>
                  <Table
                    columns={summaryColumns}
                    dataSource={summaryRows}
                    rowKey="key"
                    pagination={false}
                    size="middle"
                  />
                </>
              )
            },
            {
              key: 'review',
              label: (
                <Badge count={reviewList.length} size="small" offset={[8, -2]}>
                  补卡审核
                </Badge>
              ),
              children: (
                <Table
                  columns={reviewColumns}
                  dataSource={reviewList}
                  rowKey="id"
                  pagination={{ pageSize: 10 }}
                  size="middle"
                  locale={{ emptyText: '暂无待审核的补卡记录' }}
                />
              )
            }
          ]}
        />
      </Card>

      <Modal
        title={`补打卡 - ${target?.employee.name || ''} ${targetDate}`}
        open={modalMode === 'makeup'}
        onOk={handleMakeupSubmit}
        onCancel={() => setModalMode(null)}
        okText="确认"
        cancelText="取消"
      >
        {target?.schedule && target.schedule.shiftType !== 'off' && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message={`当日班次：${getStatusText(target.schedule.shiftType)} ${target.schedule.startTime}-${target.schedule.endTime}，签到晚于 ${target.schedule.startTime} 将记为迟到`}
          />
        )}
        {isCrossMonth && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="该记录属于历史月份，跨月补录需填写说明"
          />
        )}
        <Form form={makeupForm} layout="vertical">
          <Form.Item
            name="checkIn"
            label="签到时间"
            rules={[{ required: true, message: '请选择签到时间' }]}
          >
            <TimePicker format="HH:mm" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="checkOut" label="签退时间">
            <TimePicker format="HH:mm" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="operator"
            label="改动人"
            rules={[{ required: true, message: '请填写改动人' }]}
          >
            <Input placeholder="请填写改动人姓名" />
          </Form.Item>
          <Form.Item
            name="note"
            label="补录说明"
            rules={isCrossMonth ? [{ required: true, message: '跨月补录需填写说明' }] : []}
          >
            <Input.TextArea rows={2} placeholder={isCrossMonth ? '跨月补录必填' : '选填'} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`修改状态 - ${target?.employee.name || ''} ${targetDate}`}
        open={modalMode === 'status'}
        onOk={handleStatusSubmit}
        onCancel={() => setModalMode(null)}
        okText="确认"
        cancelText="取消"
      >
        {isCrossMonth && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="该记录属于历史月份，跨月修改需填写说明"
          />
        )}
        <Form form={statusForm} layout="vertical">
          <Form.Item
            name="status"
            label="考勤状态"
            rules={[{ required: true, message: '请选择考勤状态' }]}
          >
            <Select
              options={[
                { value: 'present', label: '出勤' },
                { value: 'late', label: '迟到' },
                { value: 'leave', label: '请假' },
                { value: 'absent', label: '缺勤' }
              ]}
            />
          </Form.Item>
          <Form.Item
            name="operator"
            label="改动人"
            rules={[{ required: true, message: '请填写改动人' }]}
          >
            <Input placeholder="请填写改动人姓名" />
          </Form.Item>
          <Form.Item
            name="note"
            label="修改说明"
            rules={isCrossMonth ? [{ required: true, message: '跨月修改需填写说明' }] : []}
          >
            <Input.TextArea rows={2} placeholder={isCrossMonth ? '跨月修改必填' : '选填'} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default AttendancePage;
