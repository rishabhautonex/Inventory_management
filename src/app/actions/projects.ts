"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { projects } from "@/db/schema";
import { canEditProjectDetails, requireUser } from "@/lib/auth";

export type Result = { ok: true } | { ok: false; error: string };

/**
 * A project's own description, repository link and documentation link.
 *
 * Separate from `createProjectAction` in [actions/admin.ts] on purpose: name,
 * code and status are administrative — every order and cupboard is filed under
 * the code — while what the project *is*, where its firmware lives and where it
 * is written up belong to the person running it. Hence a different permission
 * predicate and a different action rather than widening the admin form.
 *
 * All three columns are cleared to `null` rather than `""`. A project nobody has
 * described is a different thing from one described as nothing, and only the
 * first should prompt.
 */

/** One rule for both links, so a typo in either reads the same way. */
const link = (label: string) =>
  z
    .string()
    .trim()
    .max(2000, "That link is too long.")
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .refine(
      (value) => value === null || /^https?:\/\/\S+$/i.test(value),
      `The ${label} needs to start with http:// or https://.`,
    );

const detailsSchema = z.object({
  projectId: z.string().uuid(),
  description: z
    .string()
    .trim()
    .max(4000, "Keep the description under 4000 characters.")
    // Cleared rather than stored as "": a project nobody has described is a
    // different thing from one described as nothing, and only the first should
    // prompt for a description.
    .transform((value) => (value === "" ? null : value))
    .nullable(),
  repoUrl: link("repository link"),
  readmeUrl: link("documentation link"),
});

export type ProjectDetailsInput = z.input<typeof detailsSchema>;

export async function updateProjectDetailsAction(
  input: ProjectDetailsInput,
): Promise<Result> {
  const user = await requireUser();

  try {
    const data = detailsSchema.parse(input);

    // Re-checked here rather than trusted from the page that rendered the form,
    // like every other action in this application.
    if (!canEditProjectDetails(user, data.projectId)) {
      return {
        ok: false,
        error: "Only this project's heads, or an admin, can edit its details.",
      };
    }

    const updated = await db
      .update(projects)
      .set({
        description: data.description,
        repoUrl: data.repoUrl,
        readmeUrl: data.readmeUrl,
      })
      .where(eq(projects.id, data.projectId))
      .returning({ id: projects.id });

    if (updated.length === 0) {
      return { ok: false, error: "That project no longer exists." };
    }

    revalidatePath(`/projects/${data.projectId}`);
    revalidatePath("/projects");
    return { ok: true };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        ok: false,
        error: error.issues[0]?.message ?? "Those details could not be saved.",
      };
    }
    console.error("[project details]", error);
    return { ok: false, error: "Those details could not be saved." };
  }
}
