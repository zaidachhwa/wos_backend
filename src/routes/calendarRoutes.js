import { Router } from "express";

import { getCalendar, icsFeed, calendarPeople } from "../controllers/calendarController.js";
import { authenticate } from "../middleware/auth.js";

const router = Router();

// Public: the unguessable token is the auth (Google Calendar "From URL" sync).
router.get("/ics/:token", icsFeed);

router.use(authenticate);

router.get("/", getCalendar);
router.get("/people", calendarPeople);

export default router;
