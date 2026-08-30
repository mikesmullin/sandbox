#!/usr/bin/env bash
# After GitLab is Ready: git-over-HTTP password auth, public default visibility,
# dark UI for root, and sync root's password from Secret `gitlab`. Writes
# tmp/gitlab_password.md on the host (gitignored). Never prints the password.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NS="${NS:-agent-desktop}"
GITLAB_URL="${GITLAB_URL:-http://gitlab}"

write_password_file() {
  mkdir -p "$ROOT/tmp"
  local dest="$ROOT/tmp/gitlab_password.md"
  local pw
  pw="$(kubectl -n "$NS" get secret gitlab -o jsonpath='{.data.root-password}' 2>/dev/null | base64 -d 2>/dev/null || true)"
  if [[ -z "$pw" ]]; then
    echo "[gitlab-seed] no gitlab/root-password secret — skip $dest" >&2
    return 1
  fi
  umask 077
  python3 - "$dest" "$pw" <<'PY'
import sys
from pathlib import Path
dest, pw = Path(sys.argv[1]), sys.argv[2]
dest.write_text(
    "# GitLab (in-cluster)\n"
    "\n"
    "- URL: http://gitlab\n"
    "- Username: root\n"
    f"- Password: {pw}\n"
    "\n"
    "git CLI in desktop pods uses the credential helper.\n"
    "Do not paste this password into chat.\n"
)
dest.chmod(0o600)
PY
  echo "[gitlab-seed] wrote tmp/gitlab_password.md"
}

echo "[gitlab-seed] waiting for GitLab HTTP"
for i in $(seq 1 90); do
  if kubectl -n "$NS" exec deploy/gitlab -- curl -sf -o /dev/null "$GITLAB_URL/users/sign_in" 2>/dev/null; then
    break
  fi
  if kubectl -n "$NS" get pods -l app=gitlab -o jsonpath='{.items[0].status.containerStatuses[0].ready}' 2>/dev/null | grep -qx true; then
    if kubectl -n "$NS" exec deploy/gitlab -- curl -sf -o /dev/null http://127.0.0.1/users/sign_in 2>/dev/null; then
      break
    fi
  fi
  sleep 5
done

write_password_file || true

echo "[gitlab-seed] copy root password into GitLab pod (not printed)"
kubectl -n "$NS" get secret gitlab -o jsonpath='{.data.root-password}' \
  | base64 -d \
  | kubectl -n "$NS" exec -i deploy/gitlab -- sh -c 'cat > /tmp/root-pw && chown git:git /tmp/root-pw && chmod 600 /tmp/root-pw'

echo "[gitlab-seed] rails runner (git HTTP + public projects + dark theme + password sync)"
kubectl -n "$NS" exec deploy/gitlab -- bash -lc '
set -euo pipefail
gitlab-rails runner "
pw = File.exist?(\"/tmp/root-pw\") ? File.read(\"/tmp/root-pw\").to_s.strip : \"\"
File.delete(\"/tmp/root-pw\") if File.exist?(\"/tmp/root-pw\")
abort(\"empty root password file\") if pw.empty?
s = ApplicationSetting.current
s.password_authentication_enabled_for_git = true
s.signup_enabled = false
s.default_project_visibility = 20
s.save!
org = (defined?(Organizations::Organization) && Organizations::Organization.respond_to?(:default_organization)) ? Organizations::Organization.default_organization : nil
u = User.find_by_username(\"root\")
if u.nil?
  transient = User.new(admin: true)
  args = { email: \"admin@example.com\", name: \"Administrator\", username: \"root\", admin: true, password: pw, skip_confirmation: true }
  args[:organization_id] = org.id if org
  args[:organization_access_level] = :owner if org
  resp = Users::CreateService.new(transient, args).execute
  u = resp.respond_to?(:payload) ? resp.payload[:user] : nil
end
abort(\"no root user\") unless u
u.password = pw
u.password_confirmation = pw
u.admin = true
u.password_automatically_set = false if u.respond_to?(:password_automatically_set=)
u.confirmed_at = Time.now.utc if u.respond_to?(:confirmed_at=) && u.confirmed_at.nil?
u.theme_id = 2 if u.respond_to?(:theme_id=)
u.color_mode_id = 2 if u.respond_to?(:color_mode_id=)
u.color_scheme_id = 2 if u.respond_to?(:color_scheme_id=)
if u.namespace.nil? && u.respond_to?(:assign_personal_namespace)
  u.assign_personal_namespace(org)
end
u.save!
u.namespace.save! if u.namespace && u.namespace.has_changes_to_save?
puts \"ok\"
"
'

echo "[gitlab-seed] ApplicationSettings updated"
