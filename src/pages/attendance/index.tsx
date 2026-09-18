import React, { useMemo, useState } from 'react';
import {
  Card,
  Table,
  Tag,
  Button,
  Space,
  Select,
  Modal,
  Form,
  Input,
  DatePicker,
  TimePicker,
  message,
  Alert,
  Avatar,
  Tabs,
  Timeline,
  Typography
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  HistoryOutlined,
  CheckOutlined,
  ReloadOutlined,
  UserOutlined
} from '@ant-design/icons';
import { useSelector, useDispatch } from 'react-redux';
import type { RootState } from '../../store';
import { addAttendance, addAttendanceBatch, updateAttendance } from '../../store';
import type { Attendance, Employee, Schedule } from '../../types';
import {
  generateId,
  getStatusText,
  getStatusColor,
  getReviewStatusText,
  getAttendanceActionText,
  formatDateTime
} from '../../utils/format';
import dayjs from 'dayjs';

// 当月补打卡超过此次数后，新补卡记录需人工审核
const MAKEUP_REVIEW_THRESHOLD = 3;
const DEFAULT_OPERATOR = '管理员';

const isWorkStatus = (status: string) => status === 'present' || status === 'late';

// 'HH:mm' → dayjs（项目未注册 customParseFormat，不能直接用 dayjs(str, fmt) 解析）
const parseTime = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return dayjs().hour(h).minute(m).second(0).millisecond(0);
};

interface DailyRow {
  key: string;
  employee: Employee;
  schedule?: Schedule;
  record: Attendance | null;
}

const AttendancePage: React.FC = () => {
  const dispatch = useDispatch();
  const state = useSelector((state: RootState) => state.app);

  const [selectedDate, setSelectedDate] = useState(dayjs());
  const [selectedMonth, setSelectedMonth] = useState(dayjs());
  const [makeupOpen, setMakeupOpen] = useState(false);
  const [editRecord, setEditRecord] = useState<Attendance | null>(null);
  const [historyRecord, setHistoryRecord] = useState<Attendance | null>(null);
  const [reviewRecord, setReviewRecord] = useState<Attendance | null>(null);

  const [makeupForm] = Form.useForm();
  const [editForm] = Form.useForm();
  const [reviewForm] = Form.useForm();

  const makeupStatus = Form.useWatch('status', makeupForm);
  const editStatus = Form.useWatch('status', editForm);

  // 考勤对象：在职的美容师/技师
  const staffEmployees = useMemo(
    () =>
      state.employees.filter(
        (e) => e.status === 'active' && (e.role === 'beautician' || e.role === 'technician')
      ),
    [state.employees]
  );
  const staffIds = useMemo(() => staffEmployees.map((e) => e.id), [staffEmployees]);

  const empById = (id: string) => state.employees.find((e) => e.id === id);
  const empName = (id: string) => empById(id)?.name || id;
  const findSchedule = (employeeId: string, date: string) =>
    state.schedules.find((s) => s.employeeId === employeeId && s.date === date);

  // 考勤与当天班次对不上的情况；对得上返回 null
  const getRecordMismatch = (record: Attendance): string | null => {
    const schedule = findSchedule(record.employeeId, record.date);
    if (!schedule) return '当天无排班，却有考勤记录';
    if (schedule.shiftType === 'off' && isWorkStatus(record.status)) {
      return '当天排班为休息，却有打卡记录';
    }
    if (
      schedule.shiftType !== 'off' &&
      record.status === 'present' &&
      record.checkIn !== '--' &&
      record.checkIn > schedule.startTime
    ) {
      return `签到 ${record.checkIn} 晚于班次开始 ${schedule.startTime}，状态仍为出勤`;
    }
    return null;
  };

  const dayStr = selectedDate.format('YYYY-MM-DD');
  const monthStr = selectedMonth.format('YYYY-MM');

  const dayAttendance = useMemo(
    () => state.attendance.filter((a) => a.date === dayStr),
    [state.attendance, dayStr]
  );

  // 每日表格：当天考勤记录 ∪ 当班但还没有记录的员工
  const dailyRows = useMemo<DailyRow[]>(() => {
    const rows: DailyRow[] = [];
    dayAttendance.forEach((a) => {
      const employee = empById(a.employeeId);
      if (employee) {
        rows.push({
          key: a.id,
          employee,
          schedule: findSchedule(a.employeeId, dayStr),
          record: a
        });
      }
    });
    state.schedules
      .filter(
        (s) => s.date === dayStr && s.shiftType !== 'off' && staffIds.includes(s.employeeId)
      )
      .forEach((s) => {
        if (!dayAttendance.some((a) => a.employeeId === s.employeeId)) {
          const employee = empById(s.employeeId);
          if (employee) rows.push({ key: `missing-${s.id}`, employee, schedule: s, record: null });
        }
      });
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayAttendance, state.schedules, staffIds, dayStr]);

  // 当天班次对不上 / 缺考勤的提醒
  const dailyIssues = useMemo(() => {
    const issues: { key: string; text: string }[] = [];
    dayAttendance.forEach((a) => {
      const mismatch = getRecordMismatch(a);
      if (mismatch) {
        issues.push({
          key: a.id,
          text: `${empName(a.employeeId)}：${mismatch}（当前状态：${getStatusText(a.status)}）`
        });
      }
    });
    dailyRows
      .filter((r) => !r.record && r.schedule)
      .forEach((r) => {
        issues.push({
          key: r.key,
          text: `${r.employee.name}：当班（${getStatusText(r.schedule!.shiftType)} ${r.schedule!.startTime}-${r.schedule!.endTime}）但还没有考勤记录`
        });
      });
    return issues;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayAttendance, dailyRows]);

  const pendingReviewCount = dayAttendance.filter((a) => a.reviewStatus === 'pending').length;

  // 按天为当班人员各生成一条考勤（已存在的跳过）
  const handleGenerate = () => {
    if (dayStr > dayjs().format('YYYY-MM-DD')) {
      message.warning('不能为未来日期生成考勤');
      return;
    }
    const now = new Date().toISOString();
    const targets = state.schedules.filter(
      (s) => s.date === dayStr && s.shiftType !== 'off' && staffIds.includes(s.employeeId)
    );
    const newRecords: Attendance[] = [];
    targets.forEach((s) => {
      if (!state.attendance.some((a) => a.employeeId === s.employeeId && a.date === dayStr)) {
        newRecords.push({
          id: generateId(),
          employeeId: s.employeeId,
          date: dayStr,
          checkIn: s.startTime,
          checkOut: s.endTime,
          status: 'present',
          source: 'auto',
          reviewStatus: 'none',
          history: [
            {
              id: generateId(),
              operator: DEFAULT_OPERATOR,
              action: 'generate',
              detail: `按${getStatusText(s.shiftType)}班次（${s.startTime}-${s.endTime}）生成考勤`,
              time: now
            }
          ]
        });
      }
    });
    if (newRecords.length === 0) {
      message.info('当日当班人员均已有考勤记录，无需生成');
    } else {
      dispatch(addAttendanceBatch(newRecords));
      message.success(
        `已生成 ${newRecords.length} 条考勤${targets.length > newRecords.length ? `，${targets.length - newRecords.length} 条已存在被跳过` : ''}`
      );
    }
  };

  const openMakeup = (employeeId?: string) => {
    makeupForm.resetFields();
    makeupForm.setFieldsValue({
      employeeId,
      date: selectedDate,
      status: 'present',
      operator: DEFAULT_OPERATOR,
      note: ''
    });
    setMakeupOpen(true);
  };

  // 跨月补录必须填写说明
  const crossMonthNoteRule = (getDate: () => dayjs.Dayjs | undefined) => ({
    validator: (_: unknown, value: string) => {
      const d = getDate();
      if (d && d.format('YYYY-MM') !== dayjs().format('YYYY-MM') && (!value || !value.trim())) {
        return Promise.reject(new Error('跨月补录必须填写说明'));
      }
      return Promise.resolve();
    }
  });

  const handleMakeupSubmit = async () => {
    try {
      const values = await makeupForm.validateFields();
      const dateStr = values.date.format('YYYY-MM-DD');
      // 同一天同一个人不能有两条考勤
      if (
        state.attendance.some((a) => a.employeeId === values.employeeId && a.date === dateStr)
      ) {
        message.error('该员工当天已有考勤记录，请改用「改状态」修改');
        return;
      }
      const month = dateStr.slice(0, 7);
      const makeupCount =
        state.attendance.filter(
          (a) => a.employeeId === values.employeeId && a.source === 'makeup' && a.date.startsWith(month)
        ).length + 1;
      const needReview = makeupCount > MAKEUP_REVIEW_THRESHOLD;
      const work = isWorkStatus(values.status);
      const now = new Date().toISOString();
      const checkIn = work && values.checkIn ? values.checkIn.format('HH:mm') : '--';
      const checkOut = work && values.checkOut ? values.checkOut.format('HH:mm') : '--';

      const record: Attendance = {
        id: generateId(),
        employeeId: values.employeeId,
        date: dateStr,
        checkIn,
        checkOut,
        status: values.status,
        source: 'makeup',
        note: values.note?.trim() || undefined,
        reviewStatus: needReview ? 'pending' : 'none',
        updatedBy: values.operator,
        updatedAt: now,
        history: [
          {
            id: generateId(),
            operator: values.operator,
            action: 'makeup',
            detail: `补打卡：${getStatusText(values.status)}${work ? `，签到 ${checkIn}，签退 ${checkOut}` : ''}${values.note?.trim() ? `，说明：${values.note.trim()}` : ''}`,
            time: now
          }
        ]
      };
      dispatch(addAttendance(record));
      setMakeupOpen(false);
      if (needReview) {
        message.warning(
          `该员工本月补卡已达 ${makeupCount} 次（超过 ${MAKEUP_REVIEW_THRESHOLD} 次），该记录需人工审核`
        );
      } else {
        message.success('补打卡成功');
      }
    } catch {
      // validation error
    }
  };

  const openEdit = (record: Attendance) => {
    setEditRecord(record);
    editForm.setFieldsValue({
      status: record.status,
      checkIn: record.checkIn !== '--' ? parseTime(record.checkIn) : undefined,
      checkOut: record.checkOut !== '--' ? parseTime(record.checkOut) : undefined,
      operator: DEFAULT_OPERATOR,
      note: record.note || ''
    });
  };

  const handleEditSubmit = async () => {
    if (!editRecord) return;
    try {
      const values = await editForm.validateFields();
      const work = isWorkStatus(values.status);
      const now = new Date().toISOString();
      const checkIn = work && values.checkIn ? values.checkIn.format('HH:mm') : '--';
      const checkOut = work && values.checkOut ? values.checkOut.format('HH:mm') : '--';

      const changes: string[] = [];
      if (values.status !== editRecord.status) {
        changes.push(`状态 ${getStatusText(editRecord.status)}→${getStatusText(values.status)}`);
      }
      if (checkIn !== editRecord.checkIn) changes.push(`签到 ${editRecord.checkIn}→${checkIn}`);
      if (checkOut !== editRecord.checkOut) changes.push(`签退 ${editRecord.checkOut}→${checkOut}`);
      if ((values.note?.trim() || '') !== (editRecord.note || '')) {
        changes.push('更新说明');
      }

      const updated: Attendance = {
        ...editRecord,
        status: values.status,
        checkIn,
        checkOut,
        note: values.note?.trim() || undefined,
        updatedBy: values.operator,
        updatedAt: now,
        history: [
          ...editRecord.history,
          {
            id: generateId(),
            operator: values.operator,
            action: 'update',
            detail: changes.length > 0 ? changes.join('；') : '内容无变更',
            time: now
          }
        ]
      };
      dispatch(updateAttendance(updated));
      setEditRecord(null);
      message.success('考勤状态已更新');
    } catch {
      // validation error
    }
  };

  const handleReviewSubmit = async () => {
    if (!reviewRecord) return;
    try {
      const values = await reviewForm.validateFields();
      const now = new Date().toISOString();
      const updated: Attendance = {
        ...reviewRecord,
        reviewStatus: 'approved',
        updatedBy: values.operator,
        updatedAt: now,
        history: [
          ...reviewRecord.history,
          {
            id: generateId(),
            operator: values.operator,
            action: 'review',
            detail: '补卡记录审核通过',
            time: now
          }
        ]
      };
      dispatch(updateAttendance(updated));
      setReviewRecord(null);
      message.success('审核已通过');
    } catch {
      // validation error
    }
  };

  const dailyColumns = [
    {
      title: '员工',
      key: 'employee',
      render: (_: unknown, row: DailyRow) => (
        <Space>
          <Avatar size={32} src={row.employee.avatar} icon={<UserOutlined />} />
          <span>{row.employee.name}</span>
        </Space>
      )
    },
    {
      title: '班次',
      key: 'schedule',
      render: (_: unknown, row: DailyRow) =>
        row.schedule ? (
          <span>
            {getStatusText(row.schedule.shiftType)}
            {row.schedule.startTime !== '--' && (
              <span style={{ fontSize: 12, color: '#8c8c8c', marginLeft: 6 }}>
                {row.schedule.startTime}-{row.schedule.endTime}
              </span>
            )}
          </span>
        ) : (
          <Tag>无排班</Tag>
        )
    },
    {
      title: '状态',
      key: 'status',
      render: (_: unknown, row: DailyRow) =>
        row.record ? (
          <Tag color={getStatusColor(row.record.status)}>{getStatusText(row.record.status)}</Tag>
        ) : (
          <Tag>未打卡</Tag>
        )
    },
    {
      title: '签到',
      key: 'checkIn',
      render: (_: unknown, row: DailyRow) => row.record?.checkIn ?? '--'
    },
    {
      title: '签退',
      key: 'checkOut',
      render: (_: unknown, row: DailyRow) => row.record?.checkOut ?? '--'
    },
    {
      title: '来源',
      key: 'source',
      render: (_: unknown, row: DailyRow) =>
        row.record ? (
          <Tag color={row.record.source === 'makeup' ? 'purple' : 'default'}>
            {getStatusText(row.record.source)}
          </Tag>
        ) : (
          '—'
        )
    },
    {
      title: '审核',
      key: 'reviewStatus',
      render: (_: unknown, row: DailyRow) => {
        if (!row.record || row.record.reviewStatus === 'none') return '—';
        return (
          <Tag color={row.record.reviewStatus === 'pending' ? 'orange' : 'green'}>
            {getReviewStatusText(row.record.reviewStatus)}
          </Tag>
        );
      }
    },
    {
      title: '说明',
      key: 'note',
      render: (_: unknown, row: DailyRow) =>
        row.record?.note ? (
          <Typography.Text ellipsis={{ tooltip: row.record.note }} style={{ maxWidth: 160 }}>
            {row.record.note}
          </Typography.Text>
        ) : (
          '—'
        )
    },
    {
      title: '最后改动',
      key: 'updatedBy',
      render: (_: unknown, row: DailyRow) =>
        row.record?.updatedBy ? (
          <span style={{ fontSize: 12, color: '#8c8c8c' }}>
            {row.record.updatedBy}
            <br />
            {row.record.updatedAt ? formatDateTime(row.record.updatedAt) : ''}
          </span>
        ) : (
          '—'
        )
    },
    {
      title: '操作',
      key: 'action',
      render: (_: unknown, row: DailyRow) => (
        <Space size={4} wrap>
          {row.record ? (
            <>
              <Button
                type="link"
                size="small"
                icon={<EditOutlined />}
                onClick={() => openEdit(row.record!)}
              >
                改状态
              </Button>
              <Button
                type="link"
                size="small"
                icon={<HistoryOutlined />}
                onClick={() => setHistoryRecord(row.record)}
              >
                记录
              </Button>
              {row.record.reviewStatus === 'pending' && (
                <Button
                  type="link"
                  size="small"
                  icon={<CheckOutlined />}
                  style={{ color: '#fa8c16' }}
                  onClick={() => {
                    setReviewRecord(row.record);
                    reviewForm.setFieldsValue({ operator: DEFAULT_OPERATOR });
                  }}
                >
                  审核
                </Button>
              )}
            </>
          ) : (
            <Button
              type="link"
              size="small"
              icon={<PlusOutlined />}
              onClick={() => openMakeup(row.employee.id)}
            >
              补打卡
            </Button>
          )}
        </Space>
      )
    }
  ];

  // 月度汇总：按人统计出勤/迟到/请假/缺勤次数
  const monthlyRows = useMemo(
    () =>
      staffEmployees.map((employee) => {
        const records = state.attendance.filter(
          (a) => a.employeeId === employee.id && a.date.startsWith(monthStr)
        );
        return {
          key: employee.id,
          employee,
          present: records.filter((a) => a.status === 'present').length,
          late: records.filter((a) => a.status === 'late').length,
          leave: records.filter((a) => a.status === 'leave').length,
          absent: records.filter((a) => a.status === 'absent').length,
          makeup: records.filter((a) => a.source === 'makeup').length,
          pending: records.filter((a) => a.reviewStatus === 'pending').length,
          mismatch: records.filter((a) => getRecordMismatch(a) !== null).length
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [staffEmployees, state.attendance, state.schedules, monthStr]
  );

  const monthlyColumns = [
    {
      title: '员工',
      key: 'employee',
      render: (_: unknown, row: (typeof monthlyRows)[0]) => (
        <Space>
          <Avatar size={32} src={row.employee.avatar} icon={<UserOutlined />} />
          <span>{row.employee.name}</span>
        </Space>
      )
    },
    {
      title: '出勤',
      dataIndex: 'present',
      key: 'present',
      render: (v: number) => <span style={{ color: '#52c41a', fontWeight: 500 }}>{v}</span>
    },
    {
      title: '迟到',
      dataIndex: 'late',
      key: 'late',
      render: (v: number) => (
        <span style={{ color: v > 0 ? '#fa8c16' : undefined, fontWeight: v > 0 ? 500 : undefined }}>
          {v}
        </span>
      )
    },
    { title: '请假', dataIndex: 'leave', key: 'leave' },
    {
      title: '缺勤',
      dataIndex: 'absent',
      key: 'absent',
      render: (v: number) => (
        <span style={{ color: v > 0 ? '#f5222d' : undefined, fontWeight: v > 0 ? 500 : undefined }}>
          {v}
        </span>
      )
    },
    { title: '补卡次数', dataIndex: 'makeup', key: 'makeup' },
    {
      title: '待审核',
      dataIndex: 'pending',
      key: 'pending',
      render: (v: number) => (v > 0 ? <Tag color="orange">{v} 条待审核</Tag> : '—')
    },
    {
      title: '班次异常',
      dataIndex: 'mismatch',
      key: 'mismatch',
      render: (v: number) => (v > 0 ? <Tag color="red">{v}</Tag> : '—')
    }
  ];

  const statusOptions = [
    { value: 'present', label: '出勤' },
    { value: 'late', label: '迟到' },
    { value: 'leave', label: '请假' },
    { value: 'absent', label: '缺勤' }
  ];

  const dailyTab = (
    <>
      <Space style={{ marginBottom: 16 }} wrap>
        <DatePicker
          value={selectedDate}
          onChange={(d) => d && setSelectedDate(d)}
          allowClear={false}
        />
        <Button icon={<ReloadOutlined />} onClick={handleGenerate}>
          生成当日考勤
        </Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openMakeup()}>
          补打卡
        </Button>
      </Space>

      {dailyIssues.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`${dayStr} 有 ${dailyIssues.length} 条考勤与班次对不上`}
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {dailyIssues.map((issue) => (
                <li key={issue.key}>{issue.text}</li>
              ))}
            </ul>
          }
        />
      )}
      {pendingReviewCount > 0 && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={`当天有 ${pendingReviewCount} 条补卡记录待审核（月补卡超过 ${MAKEUP_REVIEW_THRESHOLD} 次需人工确认）`}
        />
      )}

      <Card className="card-wrapper" bordered={false} style={{ padding: 0 }}>
        <Table columns={dailyColumns} dataSource={dailyRows} pagination={false} size="middle" />
      </Card>
    </>
  );

  const monthlyTab = (
    <>
      <Space style={{ marginBottom: 16 }} wrap>
        <DatePicker
          picker="month"
          value={selectedMonth}
          onChange={(d) => d && setSelectedMonth(d)}
          allowClear={false}
        />
        <span style={{ color: '#8c8c8c', fontSize: 13 }}>
          按人汇总 {monthStr} 的出勤 / 迟到 / 请假 / 缺勤次数
        </span>
      </Space>
      <Card className="card-wrapper" bordered={false} style={{ padding: 0 }}>
        <Table columns={monthlyColumns} dataSource={monthlyRows} pagination={false} size="middle" />
      </Card>
    </>
  );

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-header-title">考勤管理</h1>
          <p className="page-header-subtitle">
            按天生成当班考勤，支持补打卡与状态修正，月度自动汇总
          </p>
        </div>
      </div>

      <Tabs
        defaultActiveKey="daily"
        items={[
          { key: 'daily', label: '每日考勤', children: dailyTab },
          { key: 'monthly', label: '月度汇总', children: monthlyTab }
        ]}
      />

      {/* 补打卡 */}
      <Modal
        title="补打卡"
        open={makeupOpen}
        onOk={handleMakeupSubmit}
        onCancel={() => setMakeupOpen(false)}
        okText="确认"
        cancelText="取消"
        width={520}
        destroyOnClose
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={`同一天同一个人只能有一条考勤；当月补卡超过 ${MAKEUP_REVIEW_THRESHOLD} 次需人工审核；跨月补录必须填写说明。`}
        />
        <Form form={makeupForm} layout="vertical">
          <Form.Item
            name="employeeId"
            label="员工"
            rules={[{ required: true, message: '请选择员工' }]}
          >
            <Select
              placeholder="请选择员工"
              options={staffEmployees.map((e) => ({ value: e.id, label: e.name }))}
            />
          </Form.Item>
          <Form.Item name="date" label="考勤日期" rules={[{ required: true, message: '请选择日期' }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="status" label="考勤状态" rules={[{ required: true, message: '请选择状态' }]}>
            <Select options={statusOptions} />
          </Form.Item>
          {isWorkStatus(makeupStatus || 'present') && (
            <Space.Compact block>
              <Form.Item
                name="checkIn"
                label="签到时间"
                style={{ width: '50%', marginRight: 8 }}
                rules={[{ required: true, message: '请选择签到时间' }]}
              >
                <TimePicker format="HH:mm" style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                name="checkOut"
                label="签退时间"
                style={{ width: '50%' }}
                rules={[{ required: true, message: '请选择签退时间' }]}
              >
                <TimePicker format="HH:mm" style={{ width: '100%' }} />
              </Form.Item>
            </Space.Compact>
          )}
          <Form.Item
            name="operator"
            label="操作人"
            rules={[{ required: true, message: '请填写操作人' }]}
          >
            <Input placeholder="谁做的这次补录" />
          </Form.Item>
          <Form.Item
            name="note"
            label="说明"
            dependencies={['date']}
            rules={[crossMonthNoteRule(() => makeupForm.getFieldValue('date'))]}
          >
            <Input.TextArea rows={2} placeholder="跨月补录必填；其他情况选填" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 改状态 */}
      <Modal
        title={editRecord ? `改状态 — ${empName(editRecord.employeeId)} ${editRecord.date}` : ''}
        open={!!editRecord}
        onOk={handleEditSubmit}
        onCancel={() => setEditRecord(null)}
        okText="确认"
        cancelText="取消"
        width={520}
        destroyOnClose
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="status" label="考勤状态" rules={[{ required: true, message: '请选择状态' }]}>
            <Select options={statusOptions} />
          </Form.Item>
          {isWorkStatus(editStatus || 'present') && (
            <Space.Compact block>
              <Form.Item name="checkIn" label="签到时间" style={{ width: '50%', marginRight: 8 }}>
                <TimePicker format="HH:mm" style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="checkOut" label="签退时间" style={{ width: '50%' }}>
                <TimePicker format="HH:mm" style={{ width: '100%' }} />
              </Form.Item>
            </Space.Compact>
          )}
          <Form.Item
            name="operator"
            label="操作人"
            rules={[{ required: true, message: '请填写操作人' }]}
          >
            <Input placeholder="谁做的这次修改" />
          </Form.Item>
          <Form.Item
            name="note"
            label="说明"
            rules={[crossMonthNoteRule(() => (editRecord ? dayjs(editRecord.date) : undefined))]}
          >
            <Input.TextArea rows={2} placeholder="跨月修改必填；其他情况选填" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 审核 */}
      <Modal
        title="补卡审核"
        open={!!reviewRecord}
        onOk={handleReviewSubmit}
        onCancel={() => setReviewRecord(null)}
        okText="审核通过"
        cancelText="取消"
        width={480}
        destroyOnClose
      >
        {reviewRecord && (
          <>
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message={`${empName(reviewRecord.employeeId)} ${reviewRecord.date} 的补卡记录（${getStatusText(reviewRecord.status)}）因当月补卡超过 ${MAKEUP_REVIEW_THRESHOLD} 次，需人工确认`}
            />
            <Form form={reviewForm} layout="vertical">
              <Form.Item
                name="operator"
                label="审核人"
                rules={[{ required: true, message: '请填写审核人' }]}
              >
                <Input placeholder="谁审核的" />
              </Form.Item>
            </Form>
          </>
        )}
      </Modal>

      {/* 改动记录 */}
      <Modal
        title={
          historyRecord ? `改动记录 — ${empName(historyRecord.employeeId)} ${historyRecord.date}` : ''
        }
        open={!!historyRecord}
        onCancel={() => setHistoryRecord(null)}
        footer={null}
        width={520}
      >
        {historyRecord && (
          <Timeline
            style={{ marginTop: 16 }}
            items={[...historyRecord.history].reverse().map((log) => ({
              key: log.id,
              children: (
                <div>
                  <div>
                    <Tag color="blue">{getAttendanceActionText(log.action)}</Tag>
                    <span style={{ fontWeight: 500 }}>{log.operator}</span>
                    <span style={{ color: '#8c8c8c', fontSize: 12, marginLeft: 8 }}>
                      {formatDateTime(log.time)}
                    </span>
                  </div>
                  <div style={{ color: '#595959', marginTop: 4 }}>{log.detail}</div>
                </div>
              )
            }))}
          />
        )}
      </Modal>
    </div>
  );
};

export default AttendancePage;
