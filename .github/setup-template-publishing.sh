#!/usr/bin/env bash
# One-time setup for .github/workflows/publish-template.yml, so the README's Launch Stack link works for this
# repository (or your fork). Needs the AWS CLI signed in to the account that will host the template, and the GitHub
# CLI signed in with access to the repository. Safe to run again.
#
#   bash .github/setup-template-publishing.sh [bucket-name]     # default: <github-owner>-relay-templates
#   RELAY_TEMPLATE_REGION=eu-west-1 bash .github/setup-template-publishing.sh   # default region: us-east-2
#
# It creates:
#   - an S3 bucket where only aws-lightsail.yaml is publicly readable
#   - GitHub's OIDC provider in IAM (if missing) and a role, relay-template-publisher, that only this repository's
#     main branch can assume, allowed only to upload that one file
#   - the repository variables TEMPLATE_BUCKET, TEMPLATE_REGION and AWS_TEMPLATE_ROLE_ARN
# then uploads the template once and prints the Launch Stack link.
set -euo pipefail

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
OWNER="${REPO%%/*}"
BUCKET="${1:-$(echo "$OWNER" | tr '[:upper:]' '[:lower:]')-relay-templates}"
ROLE=relay-template-publisher
# us-east-2 by default: accounts made with the console's free-plan team setup can only create resources there.
REGION="${RELAY_TEMPLATE_REGION:-us-east-2}"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
KEY=aws-lightsail.yaml
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
OIDC_ARN="arn:aws:iam::$ACCOUNT:oidc-provider/token.actions.githubusercontent.com"
echo "Repository $REPO, AWS account $ACCOUNT, bucket $BUCKET"

if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  if [ "$REGION" = us-east-1 ]; then
    aws s3api create-bucket --bucket "$BUCKET" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
fi
# Public through the bucket policy only (one object); ACLs stay off.
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "$(cat <<EOF
{"Version":"2012-10-17","Statement":[{"Sid":"PublicTemplate","Effect":"Allow","Principal":"*",
 "Action":"s3:GetObject","Resource":"arn:aws:s3:::$BUCKET/$KEY"}]}
EOF
)"

if ! aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_ARN" >/dev/null 2>&1; then
  aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com \
    --client-id-list sts.amazonaws.com --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 >/dev/null
fi
TRUST="$(cat <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Federated":"$OIDC_ARN"},
 "Action":"sts:AssumeRoleWithWebIdentity","Condition":{"StringEquals":{
 "token.actions.githubusercontent.com:aud":"sts.amazonaws.com",
 "token.actions.githubusercontent.com:sub":"repo:$REPO:ref:refs/heads/main"}}}]}
EOF
)"
if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$ROLE" --policy-document "$TRUST"
else
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document "$TRUST" \
    --description "GitHub Actions in $REPO: upload the Exurelay Lightsail template" >/dev/null
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name upload-template --policy-document "$(cat <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:PutObject","Resource":"arn:aws:s3:::$BUCKET/$KEY"}]}
EOF
)"
ROLE_ARN="$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text)"

gh variable set TEMPLATE_BUCKET --repo "$REPO" --body "$BUCKET"
gh variable set AWS_TEMPLATE_ROLE_ARN --repo "$REPO" --body "$ROLE_ARN"
gh variable set TEMPLATE_REGION --repo "$REPO" --body "$REGION"

# Same as the workflow does, so the link works before its first run.
TMP="$(mktemp)"
sed "s|Default: https://github.com/seika5/exurelay.git|Default: https://github.com/$REPO.git|" \
  "$(dirname "$0")/../relay-server/deploy/$KEY" > "$TMP"
aws s3 cp "$TMP" "s3://$BUCKET/$KEY" --content-type text/yaml --cache-control max-age=300 >/dev/null
rm -f "$TMP"

URL="https://$BUCKET.s3.$REGION.amazonaws.com/$KEY"
curl -fsS -o /dev/null "$URL" && echo "Template is public: $URL"
echo "Launch Stack link:"
echo "https://console.aws.amazon.com/cloudformation/home#/stacks/quickcreate?templateURL=$URL&stackName=relay"
