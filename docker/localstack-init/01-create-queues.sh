#!/bin/sh
# Executado automaticamente pelo LocalStack quando o container fica "ready"
# (montado em /etc/localstack/init/ready.d). Cria as duas filas FIFO da
# seção 10 do desafio, já com a redrive policy apontando a fila principal
# para a DLQ após esgotar maxReceiveCount — essa é a "conformidade com um
# limite de esforço antes da DLQ" exigida no desafio: o próprio SQS decide,
# não o código da aplicação.
set -e

ENDPOINT="http://localhost:4566"
REGION="us-east-1"

awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}' \
  --region "$REGION"

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$ENDPOINT/000000000000/wager-transactions-dlq.fifo" \
  --attribute-names QueueArn --region "$REGION" \
  --query 'Attributes.QueueArn' --output text)

awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}" \
  --region "$REGION"

echo "LocalStack SQS queues ready: wager-transactions.fifo -> wager-transactions-dlq.fifo (maxReceiveCount=5)"
