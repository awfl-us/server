# Reuse the current AWFL Cloud Run API as the authenticated development
# gateway. These namespace-only rules don't create a LoadBalancer, Gateway,
# Service Directory service, or additional Google Workflow.
data "google_project" "dev_gateway" {
  project_id = var.project_id
}

resource "kubernetes_role_v1" "dev_http_gateway" {
  metadata {
    name      = "awfl-dev-http-gateway"
    namespace = var.k8s_namespace
  }

  rule {
    api_groups = [""]
    resources  = ["pods"]
    verbs      = ["list"]
  }

  rule {
    api_groups = [""]
    resources  = ["pods/proxy"]
    verbs      = ["get", "create", "update", "patch", "delete"]
  }
}

resource "kubernetes_role_binding_v1" "dev_http_gateway" {
  metadata {
    name      = "awfl-dev-http-gateway-cloud-run"
    namespace = var.k8s_namespace
  }

  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "Role"
    name      = kubernetes_role_v1.dev_http_gateway.metadata[0].name
  }

  # GKE authenticates Google IAM service accounts as Kubernetes User names.
  subject {
    kind      = "User"
    name      = "${data.google_project.dev_gateway.number}-compute@developer.gserviceaccount.com"
    api_group = "rbac.authorization.k8s.io"
  }
}
