import mongoose from "mongoose";

// Per-person memory of which "getting free" emails already went out for
// their current engagement, so the hourly job never repeats one.
//   freeDay   IST day the current engagement ends (null = currently free)
//   sent      countdown offsets already emailed for that freeDay (7,5,3,2,1)
//   freeSent  the "is now free" email went out for the engagement that ended
const availabilityAlertStateSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    freeDay: { type: String, default: null },
    sent: { type: [Number], default: [] },
    freeSent: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export default mongoose.model("AvailabilityAlertState", availabilityAlertStateSchema);
