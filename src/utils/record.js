import Activity from "../models/Activity.js";
import Notification from "../models/Notification.js";
import { emitTo } from "./io.js";

// Fire-and-forget: callers don't await these, so failures must never throw
// past this module — log and move on.
export const recordActivity = ({ actor, action, entityType, entityId, project = null, meta = null }) =>
  Activity.create({ actor, action, entityType, entityId, project, meta }).catch(console.error);

export const notify = ({ user, type, title, body = "", link = "" }) =>
  Notification.create({ user, type, title, body, link })
    .then((doc) => {
      emitTo(user, "notification");
      return doc;
    })
    .catch(console.error);
