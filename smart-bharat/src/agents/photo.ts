import { structuredVision } from "../llm.js";
import { PhotoClassificationSchema, type Grievance, type GrievanceClassification, type PhotoClassification } from "../schemas.js";
import { createGrievance } from "./grievance.js";
import { departmentForCategory, humanize } from "../domain.js";
import { googleGeocode } from "../providers/google-cloud.js";

const SYSTEM = `You are a civic-issue vision classifier for an Indian municipal complaint system.
Look at the photo and decide if it shows a real public-infrastructure problem (pothole, garbage, broken streetlight, blocked/overflowing drainage, damaged road, etc.).
Judge severity from concrete visual cues: size of the damage, whether it blocks a path/road, standing/stagnant water, exposed live wires, volume of garbage, risk to pedestrians or vehicles.
If the image is not a civic issue, set is_civic_issue=false.`;

/**
 * Photo upload -> vision classification -> grievance draft, routed straight into
 * the same Grievance/Ombudsman pipeline (so it inherits SLA + escalation).
 */
export async function photoToComplaint(input: {
  user_id: string;
  imageDataUrl: string;
  imageUrl?: string; // persisted/servable URL if available
  note?: string;
}): Promise<{ grievance: Grievance | null; classification: PhotoClassification }> {
  const c = await structuredVision({
    task: "classify_photo",
    schema: PhotoClassificationSchema,
    system: SYSTEM,
    user: input.note
      ? `Citizen note: "${input.note}". Classify the civic issue in this photo.`
      : "Classify the civic issue shown in this photo.",
    imageDataUrl: input.imageDataUrl,
  });

  if (!c.is_civic_issue) {
    return { grievance: null, classification: c };
  }

  // Resolve the citizen's free-text location note to a precise address via Google
  // Maps geocoding (optional — null when no note / no Maps key), so the routed
  // department gets an actionable location instead of a vague hint.
  const geo = input.note ? await googleGeocode(input.note) : null;

  // Map the vision output onto the canonical grievance classification and file it.
  const classification: GrievanceClassification = {
    department: departmentForCategory(c.category),
    category: c.category,
    severity: c.severity,
    title: `${humanize(c.category)} (from photo)`,
    summary: `${c.description} Severity assessment: ${c.severity_reason}`,
    location_hint: geo?.formatted_address ?? input.note ?? null,
  };

  const grievance = await createGrievance({
    user_id: input.user_id,
    source: "photo",
    classification,
    image_url: input.imageUrl,
  });

  return { grievance, classification: c };
}
