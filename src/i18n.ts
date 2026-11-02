// Vietnamese UI strings. Functions return HTML-safe text unless noted; callers escape bank text.

export const COMMANDS = [
  { command: "next", description: "Ôn ngay một lượt" },
  { command: "drill", description: "Luyện phản xạ 5 phút" },
  { command: "stats", description: "Thống kê của bạn" },
  { command: "hard", description: "Những cụm hay quên nhất" },
  { command: "pause", description: "Tạm dừng nhắc, ví dụ /pause 2d" },
  { command: "resume", description: "Tiếp tục nhắc" },
  { command: "tz", description: "Đặt múi giờ, ví dụ /tz +7" },
];

export const ADMIN_COMMANDS = [
  { command: "invite", description: "Tạo mã mời" },
  { command: "members", description: "Danh sách thành viên" },
];

export const t = {
  // ----- access -----
  welcomeAdmin: (name: string) =>
    `Chào ${name}! Bạn là quản trị viên.\nDùng /invite để mời thành viên, /next để ôn ngay.`,
  welcomeMember: (name: string) =>
    `Chào ${name}! Bot sẽ gửi bạn 5–10 cụm mỗi 2 giờ, từ 08:00 đến 22:00.\nDùng /next để ôn ngay.`,
  welcomeBack: (name: string) => `Chào mừng ${name} quay lại! Tiến độ của bạn vẫn được giữ nguyên.`,
  alreadyRegistered: "Bạn đã đăng ký rồi. Dùng /next để ôn ngay.",
  inviteRequired: "Bot chỉ dành cho thành viên được mời.\nGửi <code>/start &lt;mã mời&gt;</code> để đăng ký.",
  invalidCode: "Mã mời không hợp lệ, đã dùng hoặc đã hết hạn.",
  registerFirst: "Bạn chưa đăng ký. Gửi <code>/start &lt;mã mời&gt;</code> để bắt đầu.",
  registerFirstPlain: "Bạn chưa đăng ký. Gửi /start <mã mời> để bắt đầu.", // callback notices are plain text
  adminOnly: "Lệnh này chỉ dành cho quản trị viên.",
  inviteCreated: (code: string, expires: string) =>
    `Mã mời: <code>${code}</code> (hết hạn ${expires})\nGửi cho người được mời:\n<code>/start ${code}</code>`,

  // ----- batch -----
  batchHeader: (time: string, n: number, fresh: number) => `<b>Ôn ${time}</b> · ${n} cụm${fresh ? ` (${fresh} mới)` : ""}`,
  batchFooter: "Nói to từng câu rồi bấm để chấm, hoặc gõ: <code>1o 2x 3o</code>",
  allCorrect: "Đúng hết",
  commit: "Chốt",
  drillButton: "⚡ Luyện phản xạ 5 phút",
  emptyBank: "Chưa có cụm nào để ôn.",

  // ----- grading -----
  batchClosed: "Lượt ôn này đã chốt rồi.",
  notYourBatch: "Lượt ôn này không phải của bạn.",
  noOpenBatch: "Không có lượt ôn nào đang mở để chấm. Gửi /next để ôn ngay.",
  gradeHelp:
    "Không hiểu cách chấm. Các cách gõ:\n" +
    "• <code>1o 2x 3o</code> — chấm từng câu (câu không ghi = bỏ qua)\n" +
    "• <code>oxoox</code> — chấm theo thứ tự, đủ số câu\n" +
    "• <code>ok</code> — đúng hết\n" +
    "• <code>x 2 5</code> — sai câu 2 và 5, còn lại đúng",
  score: (hits: number, graded: number) => (graded ? `✅ Kết quả: <b>${hits}/${graded}</b>` : "Bạn chưa chấm câu nào."),
  reviewAgain: "Cần ôn lại:",

  // ----- commands -----
  drillOpen: "Luyện phản xạ: 5 phút, mỗi cụm 5 giây.",
  pauseUsage: "Cách dùng: <code>/pause 3h</code> hoặc <code>/pause 2d</code> (từ 1 giờ đến 30 ngày).",
  paused: (until: string) => `Đã tạm dừng nhắc đến ${until}. Gửi /resume để tiếp tục sớm hơn.`,
  resumed: "Đã bật lại nhắc ôn.",
  tzUsage: "Cách dùng: <code>/tz +7</code>, <code>/tz -5</code> hoặc <code>/tz +5:30</code> (từ -12:00 đến +14:00).",
  tzSet: (label: string, now: string) => `Đã đặt múi giờ UTC${label}. Giờ của bạn bây giờ: ${now}.`,
  stats: (s: {
    bank: number;
    seen: number;
    boxes: number[];
    accuracy: number | null;
    streak: number;
  }) =>
    `<b>Thống kê của bạn</b>\n` +
    `Ngân hàng: ${s.bank} cụm · đã gặp: ${s.seen}\n` +
    `Hộp: ${s.boxes.map((n, i) => `${i + 1}:${n}`).join("  ")}\n` +
    `Độ chính xác 7 ngày: ${s.accuracy === null ? "chưa có" : `${Math.round(s.accuracy * 100)}%`}\n` +
    `Chuỗi ngày: ${s.streak} ngày`,
  hardTitle: "<b>Những cụm hay quên nhất</b>",
  hardEmpty: "Chưa đủ dữ liệu. Cần trả lời mỗi cụm ít nhất 3 lần.",
  membersTitle: "<b>Thành viên</b>",
  never: "chưa có",
  help:
    "Các lệnh:\n" +
    COMMANDS.map((c) => `/${c.command} — ${c.description}`).join("\n"),
  adminHelp: "\n\nQuản trị:\n" + ADMIN_COMMANDS.map((c) => `/${c.command} — ${c.description}`).join("\n"),
};
