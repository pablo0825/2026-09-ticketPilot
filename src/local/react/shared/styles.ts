// 共用外觀使用完整 Tailwind classes，讓打包器可靜態辨識。
export const primaryButton =
    "rounded-lg border border-blue-600 bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50";
export const secondaryButton =
    "rounded-lg border border-slate-300 bg-white px-4 py-2 text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50";
export const panel = "rounded-xl border border-slate-200 bg-white p-4 sm:p-6";

export const badgeColors = {
    done: "bg-emerald-50 text-emerald-800",
    info: "bg-blue-50 text-blue-800",
    action: "bg-amber-50 text-amber-800",
    neutral: "bg-slate-100 text-slate-600",
    error: "bg-red-50 text-red-800",
    unknown: "bg-yellow-50 text-yellow-800",
};

export const fieldLabel = "flex min-w-0 flex-col gap-2 text-sm";
export const fieldInput =
    "w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 focus:outline-2 focus:outline-blue-600 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500";
