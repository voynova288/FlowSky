export async function get_current_time(args: { timezone?: string } = {}) {
  const now = new Date();
  return {
    iso: now.toISOString(),
    timezone: args.timezone ?? "UTC",
    display: now.toLocaleString("zh-CN", { timeZone: args.timezone ?? "UTC" }),
  };
}
