import mongoose from "mongoose";

import GeneralTask from "../models/GeneralTask.js";
import User from "../models/User.js";
import { notify } from "../utils/record.js";

// The Director's "General" tasks. Creators (director/admin) create, edit and
// delete; each assignee marks the task done for themselves.

export const GENERAL_TASK_CREATORS = ["director", "admin"];

const fail = (res, status, message) => res.status(status).json({ success: false, message });
const serverError = (res, error) => {
  if (error?.name === "CastError") return fail(res, 400, "Invalid identifier");
  if (error?.name === "ValidationError") return fail(res, 400, "Invalid task details");
  console.error(error);
  return fail(res, 500, "Something went wrong");
};

// pending  — not done, not yet due
// completed — done on or before the due time
// delayed  — done after the due time
// overdue  — past due and still not done
export const assignmentStatus = (dueAt, completedAt, now = new Date()) => {
  if (completedAt) return new Date(completedAt) <= new Date(dueAt) ? "completed" : "delayed";
  return now > new Date(dueAt) ? "overdue" : "pending";
};

const emptyStats = () => ({ total: 0, completed: 0, delayed: 0, overdue: 0, pending: 0 });

const shape = (task, now) => {
  const t = task.toObject ? task.toObject() : task;
  const assignments = t.assignments.map((a) => ({ ...a, status: assignmentStatus(t.dueAt, a.completedAt, now) }));
  const stats = emptyStats();
  for (const a of assignments) {
    stats.total += 1;
    stats[a.status] += 1;
  }
  return { ...t, assignments, stats };
};

const populate = (q) => q.populate("assignments.user", "name email role designation").populate("createdBy", "name role");

const isCreator = (user) => GENERAL_TASK_CREATORS.includes(user.role);
const canEdit = (user, task) => user.role === "admin" || String(task.createdBy?._id || task.createdBy) === String(user._id);

const parseBody = async (body, { partial = false } = {}) => {
  const out = {};
  if (!partial || body.title !== undefined) {
    const title = String(body.title || "").trim();
    if (!title) return { error: "Title is required" };
    out.title = title.slice(0, 200);
  }
  if (body.description !== undefined) out.description = String(body.description || "").slice(0, 5000);
  if (!partial || body.dueAt !== undefined) {
    const dueAt = new Date(body.dueAt);
    if (!body.dueAt || Number.isNaN(dueAt.getTime())) return { error: "A valid due date and time is required" };
    out.dueAt = dueAt;
  }
  if (!partial || body.assignees !== undefined) {
    const ids = [...new Set((Array.isArray(body.assignees) ? body.assignees : []).map(String))];
    if (!ids.length) return { error: "Choose at least one assignee" };
    if (!ids.every((id) => mongoose.isValidObjectId(id))) return { error: "Invalid assignee" };
    const found = await User.countDocuments({ _id: { $in: ids }, isActive: true });
    if (found !== ids.length) return { error: "One or more assignees don't exist or are inactive" };
    out.assignees = ids;
  }
  return { value: out };
};

const notifyAssigned = (userIds, task, actor) => {
  for (const id of userIds) {
    if (String(id) === String(actor._id)) continue;
    notify({
      user: id,
      type: "general_task",
      title: `${actor.name} assigned you a task: "${task.title}"`,
      body: `Due ${new Date(task.dueAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}`,
      link: "/general",
    });
  }
};

// scope=assigned (default): tasks assigned to me, each with my own status.
// scope=created: tasks I created (admin: every general task), with every assignee.
export const listGeneralTasks = async (req, res) => {
  try {
    const now = new Date();
    const scope = req.query.scope === "created" ? "created" : "assigned";
    if (scope === "created" && !isCreator(req.user)) return fail(res, 403, "Forbidden");

    const filter = scope === "created" ? (req.user.role === "admin" ? {} : { createdBy: req.user._id }) : { "assignments.user": req.user._id };
    const tasks = (await populate(GeneralTask.find(filter).sort({ dueAt: -1 })).limit(1000).lean()).map((t) => shape(t, now));

    let rows = tasks;
    const stats = emptyStats();
    if (scope === "assigned") {
      rows = tasks.map((t) => {
        const mine = t.assignments.find((a) => String(a.user?._id) === String(req.user._id));
        return { ...t, myStatus: mine?.status, myCompletedAt: mine?.completedAt || null };
      });
      for (const t of rows) {
        stats.total += 1;
        stats[t.myStatus] += 1;
      }
    } else {
      for (const t of rows) for (const k of Object.keys(stats)) stats[k] += t.stats[k];
    }

    const status = req.query.status;
    if (status) {
      rows = scope === "assigned" ? rows.filter((t) => t.myStatus === status) : rows.filter((t) => t.stats[status] > 0);
    }

    // Per-person breakdown for the creator view.
    let byPerson = [];
    if (scope === "created") {
      const map = new Map();
      for (const t of tasks) {
        for (const a of t.assignments) {
          const key = String(a.user?._id);
          if (!map.has(key)) map.set(key, { user: a.user, ...emptyStats() });
          const p = map.get(key);
          p.total += 1;
          p[a.status] += 1;
        }
      }
      byPerson = [...map.values()].sort((a, b) => b.overdue - a.overdue || b.delayed - a.delayed || (a.user?.name || "").localeCompare(b.user?.name || ""));
    }

    return res.json({ success: true, message: "General tasks fetched", data: { scope, tasks: rows, stats, byPerson } });
  } catch (error) {
    return serverError(res, error);
  }
};

export const createGeneralTask = async (req, res) => {
  try {
    const { value, error } = await parseBody(req.body || {});
    if (error) return fail(res, 400, error);
    const task = await GeneralTask.create({
      title: value.title,
      description: value.description || "",
      dueAt: value.dueAt,
      assignments: value.assignees.map((user) => ({ user })),
      createdBy: req.user._id,
    });
    notifyAssigned(value.assignees, task, req.user);
    const fresh = await populate(GeneralTask.findById(task._id)).lean();
    return res.status(201).json({ success: true, message: "Task assigned", data: { task: shape(fresh, new Date()) } });
  } catch (error) {
    return serverError(res, error);
  }
};

// Editing keeps the completion of assignees who stay on the task; newly
// added assignees start as not done and are notified.
export const updateGeneralTask = async (req, res) => {
  try {
    const task = await GeneralTask.findById(req.params.id);
    if (!task) return fail(res, 404, "Task not found");
    if (!canEdit(req.user, task)) return fail(res, 403, "Only the person who created this task can edit it");
    const { value, error } = await parseBody(req.body || {}, { partial: true });
    if (error) return fail(res, 400, error);

    if (value.title !== undefined) task.title = value.title;
    if (value.description !== undefined) task.description = value.description;
    if (value.dueAt !== undefined) task.dueAt = value.dueAt;
    let added = [];
    if (value.assignees) {
      const existing = new Map(task.assignments.map((a) => [String(a.user), a]));
      added = value.assignees.filter((id) => !existing.has(id));
      task.assignments = value.assignees.map((id) => existing.get(id) || { user: id, completedAt: null });
    }
    await task.save();
    notifyAssigned(added, task, req.user);
    const fresh = await populate(GeneralTask.findById(task._id)).lean();
    return res.json({ success: true, message: "Task updated", data: { task: shape(fresh, new Date()) } });
  } catch (error) {
    return serverError(res, error);
  }
};

export const deleteGeneralTask = async (req, res) => {
  try {
    const task = await GeneralTask.findById(req.params.id);
    if (!task) return fail(res, 404, "Task not found");
    if (!canEdit(req.user, task)) return fail(res, 403, "Only the person who created this task can delete it");
    await task.deleteOne();
    return res.json({ success: true, message: "Task deleted" });
  } catch (error) {
    return serverError(res, error);
  }
};

// An assignee marks their own part done (done: true) or undoes it (done: false).
export const setGeneralTaskDone = async (req, res) => {
  try {
    const done = req.body?.done !== false;
    const updated = await GeneralTask.findOneAndUpdate(
      { _id: req.params.id, "assignments.user": req.user._id },
      { $set: { "assignments.$.completedAt": done ? new Date() : null } },
      { returnDocument: "after" }
    );
    if (!updated) return fail(res, 404, "Task not found or not assigned to you");
    if (done && String(updated.createdBy) !== String(req.user._id)) {
      notify({ user: updated.createdBy, type: "general_task", title: `${req.user.name} completed "${updated.title}"`, link: "/general" });
    }
    const fresh = await populate(GeneralTask.findById(updated._id)).lean();
    return res.json({ success: true, message: done ? "Marked as done" : "Marked as not done", data: { task: shape(fresh, new Date()) } });
  } catch (error) {
    return serverError(res, error);
  }
};
