// Single import point so every schema is registered with mongoose before the
// first query runs (a populate ref would otherwise throw MissingSchemaError).
//
// app.js imports this file for that side effect alone, so the order here does
// not matter - but every new model must be added, or the first populate that
// reaches it fails at runtime rather than at boot.

// Account and profile
export { User } from "./user.model.js";
export { Profile } from "./profile.model.js";
export { Education } from "./education.model.js";
export { Profession } from "./profession.model.js";
export { Family } from "./family.model.js";
export { PartnerPreference } from "./partnerPreference.model.js";
export { ProfilePhoto } from "./profilePhoto.model.js";
export { ProfileVerification } from "./profileVerification.model.js";

// Discovery and interaction
export { ProfileView } from "./profileView.model.js";
export { Like } from "./like.model.js";
export { Pass } from "./pass.model.js";
export { Match, orderPair } from "./match.model.js";
export { Block } from "./block.model.js";
export { Report } from "./report.model.js";

// Chat
export { Conversation } from "./conversation.model.js";
export { Message } from "./message.model.js";

// Notifications, money
export { Notification } from "./notification.model.js";
export { SubscriptionPlan } from "./subscriptionPlan.model.js";
export { Subscription } from "./subscription.model.js";
export { Payment } from "./payment.model.js";

// Credentials and accountability
export { OtpVerification } from "./otpVerification.model.js";
export { RefreshToken } from "./refreshToken.model.js";
export { AuditLog } from "./auditLog.model.js";
