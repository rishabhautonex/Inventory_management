import { eq } from "drizzle-orm";

import {
  boms,
  locations,
  orders,
  partRequests,
  projectLeads,
  projects,
} from "@/db/schema";
import type { Database } from "@/db/types";

/**
 * Deleting a project.
 *
 * Closing a project is the reversible option and is what almost every case
 * wants — a finished project keeps its cupboards, its spend and its history,
 * and stops appearing as somewhere to file new work. Deleting is for a project
 * that should never have existed: a typo, a duplicate, a demo row.
 *
 * Everything the delete touches is spelled out here rather than left to the
 * foreign keys, for two reasons. The counts have to be real, because they are
 * what the reviewer is shown before they confirm and what they are told
 * afterwards; and `part_requests.project_id` is `ON DELETE restrict`, so the
 * database refuses to drop a project out from under somebody's requests. That
 * guard stays exactly where it is. This function is the one deliberate path
 * through it, and it says out loud what it destroys.
 *
 * Two halves, and the difference matters:
 *
 *  - **Destroyed.** The project's BOMs (and their lines, by cascade), the part
 *    requests raised against it, and its heads' assignments. These are records
 *    of what the project wanted, and without the project they are unreadable.
 *  - **Detached.** Its cupboards and its orders survive with `project_id` null.
 *    An order is evidence that money was spent and a cupboard still holds real
 *    parts; deleting either would make the ledger describe stock nobody bought.
 *    They stop being attributable to the project, which is the cost of this
 *    operation and why the screen states the counts before asking.
 *
 * Nothing here touches `stock_movements`. A location keeps every movement
 * against it, so the on-hand figure for each shelf is exactly what it was.
 *
 * All of it in one transaction: a half-done delete would leave requests
 * pointing at a project that is gone, which is precisely what the restrict
 * exists to prevent.
 */

export type ProjectDeletion = {
  name: string;
  code: string;
  /** Gone with the project. */
  deletedRequests: number;
  deletedBoms: number;
  removedHeads: number;
  /** Still there, no longer filed under it. */
  detachedCupboards: number;
  detachedOrders: number;
};

/** Returns null when the project is already gone. */
export async function deleteProjectCascade(
  db: Database,
  projectId: string,
): Promise<ProjectDeletion | null> {
  return db.transaction(async (tx) => {
    const [project] = await tx
      .select({ id: projects.id, name: projects.name, code: projects.code })
      .from(projects)
      .where(eq(projects.id, projectId));

    if (!project) return null;

    const heads = await tx
      .delete(projectLeads)
      .where(eq(projectLeads.projectId, project.id))
      .returning({ userId: projectLeads.userId });

    const cupboards = await tx
      .update(locations)
      .set({ projectId: null })
      .where(eq(locations.projectId, project.id))
      .returning({ id: locations.id });

    const detachedOrders = await tx
      .update(orders)
      .set({ projectId: null })
      .where(eq(orders.projectId, project.id))
      .returning({ id: orders.id });

    const requests = await tx
      .delete(partRequests)
      .where(eq(partRequests.projectId, project.id))
      .returning({ id: partRequests.id });

    const deletedBoms = await tx
      .delete(boms)
      .where(eq(boms.projectId, project.id))
      .returning({ id: boms.id });

    await tx.delete(projects).where(eq(projects.id, project.id));

    return {
      name: project.name,
      code: project.code,
      deletedRequests: requests.length,
      deletedBoms: deletedBoms.length,
      removedHeads: heads.length,
      detachedCupboards: cupboards.length,
      detachedOrders: detachedOrders.length,
    };
  });
}
