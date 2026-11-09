# Optional project-wide monthly billing alert (NOT an enforceable GKE cost cap).
# Google spend-cap budgets currently do not support GKE.
# Omit billing_account_id to skip creation when billing permission is missing.
variable "billing_account_id" {
  description = "Cloud Billing account ID; blank disables the optional alert."
  type        = string
  default     = ""
}

variable "project_monthly_budget_alert_usd" {
  description = "Monthly project-wide alert threshold, in USD. Not a spending cap."
  type        = number
  default     = 50
  validation {
    condition     = var.project_monthly_budget_alert_usd >= 1 && floor(var.project_monthly_budget_alert_usd) == var.project_monthly_budget_alert_usd
    error_message = "Monthly budget alert must be a positive whole USD amount."
  }
}

data "google_project" "billing_alert_scope" {
  count      = var.billing_account_id != "" ? 1 : 0
  project_id = var.project_id
}

resource "google_billing_budget" "awfl_project_alert" {
  count           = var.billing_account_id != "" ? 1 : 0
  billing_account = var.billing_account_id
  display_name    = "AWFL project monthly spend alert"

  budget_filter {
    projects        = ["projects/${data.google_project.billing_alert_scope[0].number}"]
    calendar_period = "MONTH"
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.project_monthly_budget_alert_usd)
    }
  }

  threshold_rules { threshold_percent = 0.5 }
  threshold_rules { threshold_percent = 0.8 }
  threshold_rules { threshold_percent = 1.0 }
}
