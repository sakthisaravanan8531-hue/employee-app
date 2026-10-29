# Turn the application ON or OFF

Use **GitHub → employee-app → Actions → Application ON or OFF → Run workflow**. Select branch **main**, choose `on`, `off` or `status`, and run it whenever needed. The production environment's existing approval rules still apply. There is no fixed daily schedule; you choose the time manually.

These controls become usable after the AWS stack and GitHub repository variables are configured. The stack must include the new Lambda concurrency permissions; apply a reviewed CDK update with your authorized operator identity first. AWS access has not yet been connected in this development environment, so the live switch has not been exercised.

| Selection | Result                                                                                                                                                                      |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`     | Sets Lambda reserved concurrency to zero, verifies it, then publishes a small offline page to Amplify and checks it appeared.                                               |
| `on`      | Tests/builds the selected main-branch commit, restores concurrency to two, publishes/verifies the Lambda and React app.                                                     |
| `status`  | Reads backend reserved concurrency without modifying resources. Zero means off; another value means backend invocation is enabled, not that every application check passed. |

The OFF setting blocks **new** Lambda invocations; in-flight requests can finish. Existing browser tabs may show the old interface until refreshed, but backend requests cannot run while concurrency is zero. Employee records, credentials and previous Lambda versions are preserved. Amplify remains online to serve the offline page; this is an application pause, not deletion of all AWS resources.

## How deployments behave while OFF

Normal pushes still run verification, but the release script reads Lambda concurrency and skips AWS publication when it is zero. A push does not silently turn the app back on or replace the maintenance page. Both the deployment workflow and power workflow use the same production concurrency group to avoid overlapping operations. Infrastructure deployment is separate: a CDK update can affect the runtime configuration and must not overlap a pause/resume operation. Recheck state afterward.

ON deliberately deploys the current selected main commit, rather than reusing potentially incompatible frontend code with an older backend. It therefore takes build/deployment time; it is not instant. If ON fails during deployment/health checks, the control resets concurrency to zero and fails the job. The frontend might still show an old interface or maintenance page depending on the failed step, but the backend stays blocked. Inspect the failed run before retrying. If the OFF maintenance publication fails, the backend remains off and the workflow reports failure; retry OFF to finish publishing the page.

## Costs while OFF

Serverless Lambda already has no idle execution charge without requests. OFF mainly prevents unwanted invocations, database operations and their related usage. It does **not** eliminate retained DynamoDB storage, Secrets Manager, CloudWatch metric/alarm/storage, Amplify storage/maintenance-page transfer, CDK assets or requests made directly to API Gateway. Budget alerts remain active and are not a spending cap. Do not expect zero charges merely because status reports OFF.

For long-term removal, export needed records and deliberately tear down resources following deployment.md/costs.md. Data deletion is separate from this switch and is never performed by the power workflow.

## Operator CLI alternative

With an already configured authorized AWS CLI session and the same FUNCTION_NAME, AMPLIFY_APP_ID, APP_URL and API_URL variables used by GitHub:

```sh
python3 deployment/scripts/power.py status
python3 deployment/scripts/power.py off
```

For ON, first test/build the intended commit with RELEASE_SHA set to its full Git SHA, then use `python3 deployment/scripts/power.py on`. The GitHub workflow performs those preparations automatically and is the preferred option. Never put AWS credentials into the script, source code or chat.
