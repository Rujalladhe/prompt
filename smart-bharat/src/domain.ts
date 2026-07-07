import type { CATEGORIES, DEPARTMENTS } from "./schemas.js";

type Department = (typeof DEPARTMENTS)[number];
type Category = (typeof CATEGORIES)[number];

/**
 * Single source of truth for civic-domain vocabulary that used to be duplicated
 * across photo.ts, ombudsman.ts and the orchestrator (drift risk: three encodings
 * of the same department knowledge). Add a department/category here, everywhere
 * that renders or routes it stays consistent.
 */

/** Turn an enum-ish snake_case token into a human label ("power_cut" -> "power cut"). */
export const humanize = (s: string): string => s.replace(/_/g, " ");

/** Formal, letter-ready name for a department (used in follow-ups and RTI drafts). */
export const DEPT_LABEL: Record<Department, string> = {
  municipal_corporation: "Municipal Corporation",
  public_works: "Public Works Department (PWD)",
  water_board: "Water Supply & Sewerage Board",
  electricity_board: "State Electricity Board",
  sanitation: "Sanitation / Solid Waste Department",
  police: "Police Department",
  transport: "Transport Department",
  health: "Health Department",
  other: "Concerned Department",
};

export const departmentLabel = (d: string): string => DEPT_LABEL[d as Department] ?? "Concerned Department";

/** Map a civic issue category to the department that owns it. */
export function departmentForCategory(category: string): Department {
  switch (category as Category) {
    case "pothole":
    case "road_damage":
      return "public_works";
    case "garbage":
    case "drainage":
      return "sanitation";
    case "streetlight":
    case "power_cut":
      return "electricity_board";
    case "water_supply":
      return "water_board";
    case "public_safety":
      return "police";
    default:
      return "municipal_corporation";
  }
}
