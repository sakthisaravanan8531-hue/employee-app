interface BootstrapConfig {
  releaseParameter: string;
  dbSecret: string;
  dbHost: string;
  adminSecret: string;
  sessionSecret: string;
  logGroup: string;
  region: string;
}
export function bootstrap(c: BootstrapConfig): string {
  return `set -euo pipefail
exec > >(tee /var/log/employee-bootstrap.log | logger -t employee-bootstrap) 2>&1
# No secret values are retrieved here or embedded in this launch template.
dnf install -y nodejs22 nodejs22-npm amazon-cloudwatch-agent unzip jq
id employee >/dev/null 2>&1 || useradd --system --home-dir /opt/employee --shell /sbin/nologin employee
mkdir -p /opt/employee /var/log/employee
chown employee:employee /var/log/employee
RELEASE=$(aws ssm get-parameter --name '${c.releaseParameter}' --region '${c.region}' --query Parameter.Value --output text)
aws s3 cp "s3://$RELEASE" /tmp/backend.zip --region '${c.region}'
unzip -q /tmp/backend.zip -d /opt/employee
NODE=$(command -v node-22 || command -v node)
NPM=$(command -v npm-22 || command -v npm)
cd /opt/employee
$NPM ci --omit=dev --workspaces=false --no-audit --no-fund
curl --fail --silent --show-error --retry 5 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /opt/employee/rds-ca.pem
chown -R employee:employee /opt/employee
cat > /etc/employee.conf <<'ENV'
NODE_ENV=production
PORT=8080
AWS_REGION=${c.region}
DB_SECRET_ARN=${c.dbSecret}
DB_HOST=${c.dbHost}
DB_NAME=employee
AUTH_SECRET_ARN=${c.adminSecret}
SESSION_SECRET_ARN=${c.sessionSecret}
RDS_CA_PATH=/opt/employee/rds-ca.pem
ENV
# Immutable build ID is written into each release; never evaluate artifact content as shell.
VERSION=$(cat /opt/employee/VERSION 2>/dev/null || echo initial)
printf 'APP_VERSION=%s\\n' "$VERSION" >> /etc/employee.conf
chmod 640 /etc/employee.conf
cat > /etc/systemd/system/employee.service <<UNIT
[Unit]
Description=Employee REST API
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=employee
Group=employee
WorkingDirectory=/opt/employee
EnvironmentFile=/etc/employee.conf
ExecStart=$NODE /opt/employee/src/server.js
Restart=always
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/log/employee
StandardOutput=append:/var/log/employee/api.log
StandardError=append:/var/log/employee/api.log
TimeoutStopSec=30
[Install]
WantedBy=multi-user.target
UNIT
cat > /opt/aws/amazon-cloudwatch-agent/etc/employee.json <<'CW'
{"agent":{"metrics_collection_interval":60},"metrics":{"namespace":"EmployeeApp","append_dimensions":{"AutoScalingGroupName":"\${aws:AutoScalingGroupName}","InstanceId":"\${aws:InstanceId}"},"aggregation_dimensions":[["AutoScalingGroupName"]],"metrics_collected":{"mem":{"measurement":["mem_used_percent"]}}},"logs":{"logs_collected":{"files":{"collect_list":[{"file_path":"/var/log/employee/api.log","log_group_name":"${c.logGroup}","log_stream_name":"{instance_id}/api"},{"file_path":"/var/log/employee-bootstrap.log","log_group_name":"${c.logGroup}","log_stream_name":"{instance_id}/bootstrap"}]}}}}
CW
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:/opt/aws/amazon-cloudwatch-agent/etc/employee.json -s
systemctl daemon-reload
systemctl enable --now employee
for attempt in $(seq 1 90); do
  if curl --fail --silent http://127.0.0.1:8080/api/health; then exit 0; fi
  sleep 5
done
exit 1`;
}
