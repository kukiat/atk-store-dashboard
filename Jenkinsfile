// atk-store-dashboard — Jenkins job: https://jenkins.hexdas.cloud/job/atk-store-dashboard/
// Script Path (default): Jenkinsfile
//
// Deploys the same stack that already runs on the host as:
//   atk-store      → web  (Host: atk.hexdas.cloud)
//   atk-store-api  → api  (PathPrefix on the same host)
// Compose path: /docker/hexdas/atk  (alongside atk-store-mqtt / shelfbox)
//
// Agent is linux/amd64 — uses plain `docker build` / `docker push` (no buildx required).
// Jenkins อยู่เครื่องเดียวกับ deploy → default DEPLOY_MODE=local (ไม่ต้อง SSH)
//
// Credentials (Jenkins → Manage Credentials):
//   dockerhub-creds  — Username with password (Docker Hub: bunchax)
//   hexdas-ssh       — เฉพาะเมื่อ DEPLOY_MODE=ssh

pipeline {
  agent any

  options {
    timestamps()
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '20'))
  }

  parameters {
    choice(name: 'TARGET', choices: ['all', 'web', 'api'], description: 'What to build & deploy (web=atk-store, api=atk-store-api)')
    string(name: 'IMAGE_TAG', defaultValue: 'latest', description: 'Docker image tag')
    string(
      name: 'VITE_API_URL',
      defaultValue: 'https://atk.hexdas.cloud',
      description: 'API base URL baked into the web image (same Traefik host; API via PathPrefix)'
    )
    booleanParam(name: 'DEPLOY', defaultValue: true, description: 'Recreate compose services after push')
    choice(name: 'DEPLOY_MODE', choices: ['local', 'ssh'], description: 'local = docker compose on this agent (same host); ssh = remote')
    string(name: 'DEPLOY_HOST', defaultValue: '76.13.209.136', description: 'SSH host when DEPLOY_MODE=ssh')
    string(name: 'DEPLOY_PATH', defaultValue: '/docker/hexdas/atk', description: 'Compose project path on the Docker host')
    string(name: 'DOCKERHUB_CRED_ID', defaultValue: 'dockerhub-creds', description: 'Jenkins Credentials ID only (e.g. dockerhub-creds) — NOT the dckr_pat_ token')
    string(name: 'SSH_CRED_ID', defaultValue: 'hexdas-ssh', description: 'Only used when DEPLOY_MODE=ssh')
  }

  environment {
    // Replaces armdocker123/atk-store once compose image lines are updated
    WEB_IMAGE = 'bunchax/atk-store'
    API_IMAGE = 'bunchax/atk-store-api'
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
      }
    }

    stage('Validate credentials params') {
      steps {
        script {
          // First builds / blank param overrides often leave strings empty — coerce defaults.
          def tag = (params.IMAGE_TAG ?: '').toString().trim()
          env.IMAGE_TAG = tag ?: 'latest'
          def viteUrl = (params.VITE_API_URL ?: '').toString().trim()
          env.VITE_API_URL = viteUrl ?: 'https://atk.hexdas.cloud'
          echo "IMAGE_TAG=${env.IMAGE_TAG} VITE_API_URL=${env.VITE_API_URL}"

          def hubId = (params.DOCKERHUB_CRED_ID ?: '').toString().trim()
          def sshId = (params.SSH_CRED_ID ?: '').toString().trim()
          if (hubId.startsWith('dckr_pat_') || hubId.contains('/') || hubId.length() > 80) {
            error '''DOCKERHUB_CRED_ID must be a Jenkins credential ID (e.g. dockerhub-creds), not the Docker Hub PAT.

Create it in Jenkins → Manage Jenkins → Credentials:
  Kind: Username with password
  ID: dockerhub-creds
  Username: your Docker Hub username (e.g. bunchax)
  Password: the dckr_pat_… token

Then leave DOCKERHUB_CRED_ID = dockerhub-creds'''
          }
          if (!hubId) {
            error 'DOCKERHUB_CRED_ID is empty'
          }
          echo "Using Docker Hub credential ID: ${hubId}"
          if (paramBool('DEPLOY') && params.DEPLOY_MODE == 'ssh') {
            if (!sshId) {
              error 'SSH_CRED_ID is empty (needed for DEPLOY_MODE=ssh)'
            }
            echo "Using SSH credential ID: ${sshId}"
          } else if (paramBool('DEPLOY')) {
            echo "DEPLOY_MODE=local — deploy via docker CLI helper mounting host ${params.DEPLOY_PATH}"
          }
        }
      }
    }

    stage('Docker check') {
      steps {
        sh '''
          set -e
          command -v docker >/dev/null || { echo "ERROR: docker not found on agent"; exit 1; }
          docker version
          ARCH="$(docker info --format '{{.Architecture}}' 2>/dev/null || true)"
          echo "Docker architecture: ${ARCH:-unknown}"
        '''
      }
    }

    stage('Build & Push web') {
      when {
        expression { return targetIncludes('web') }
      }
      steps {
        withCredentials([usernamePassword(
          credentialsId: params.DOCKERHUB_CRED_ID,
          usernameVariable: 'DOCKER_USER',
          passwordVariable: 'DOCKER_PASS'
        )]) {
          sh '''
            set -e
            echo "$DOCKER_PASS" | docker login -u "$DOCKER_USER" --password-stdin

            docker build \
              -f apps/web/Dockerfile \
              --build-arg VITE_API_URL="${VITE_API_URL}" \
              -t "${WEB_IMAGE}:${IMAGE_TAG}" \
              -t "${WEB_IMAGE}:latest" \
              .

            docker push "${WEB_IMAGE}:${IMAGE_TAG}"
            docker push "${WEB_IMAGE}:latest"
            docker image inspect "${WEB_IMAGE}:${IMAGE_TAG}" --format 'Arch={{.Architecture}} Os={{.Os}}'
          '''
        }
      }
    }

    stage('Build & Push api') {
      when {
        expression { return targetIncludes('api') }
      }
      steps {
        withCredentials([usernamePassword(
          credentialsId: params.DOCKERHUB_CRED_ID,
          usernameVariable: 'DOCKER_USER',
          passwordVariable: 'DOCKER_PASS'
        )]) {
          sh '''
            set -e
            echo "$DOCKER_PASS" | docker login -u "$DOCKER_USER" --password-stdin

            docker build \
              -f apps/api/Dockerfile \
              -t "${API_IMAGE}:${IMAGE_TAG}" \
              -t "${API_IMAGE}:latest" \
              .

            docker push "${API_IMAGE}:${IMAGE_TAG}"
            docker push "${API_IMAGE}:latest"
            docker image inspect "${API_IMAGE}:${IMAGE_TAG}" --format 'Arch={{.Architecture}} Os={{.Os}}'
          '''
        }
      }
    }

    stage('Deploy') {
      when {
        expression { return paramBool('DEPLOY') }
      }
      steps {
        script {
          // Must match service names in /docker/hexdas/atk docker-compose
          def services = []
          if (targetIncludes('web')) { services << 'atk-store' }
          if (targetIncludes('api'))  { services << 'atk-store-api' }
          def svc = services.join(' ')
          if (!svc) {
            error 'No compose services selected for TARGET'
          }

          def remote = """
            set -e
            cd ${params.DEPLOY_PATH}
            docker compose pull ${svc}
            docker compose up -d --force-recreate ${svc}
            docker image prune -f
          """.stripIndent().trim()

          runRemote(remote)
        }
      }
    }
  }

  post {
    always {
      sh 'docker logout || true'
    }
    success {
      echo "OK — TARGET=${params.TARGET} tag=${env.IMAGE_TAG} deploy=${params.DEPLOY} mode=${params.DEPLOY_MODE}"
    }
    failure {
      echo '''
FAILED — common causes:
  1) Empty IMAGE_TAG → invalid docker tag (leave default "latest")
  2) Credential ID mismatch (DOCKERHUB_CRED_ID)
  3) Agent missing docker / permission to docker.sock
  4) DEPLOY_MODE=local: host must have DEPLOY_PATH and env files used by compose
  5) Compose still points at armdocker123/* — update image lines to bunchax/atk-store*
'''
    }
  }
}

boolean paramBool(String name) {
  def v = params[name]
  if (v == null) { return false }
  if (v instanceof Boolean) { return v }
  return v.toString().toBoolean()
}

boolean targetIncludes(String name) {
  def t = (params.TARGET ?: 'all').toString()
  return t == 'all' || t == name
}

/**
 * Run compose commands on the Docker host.
 * Jenkins often runs inside a container (no /docker/... visible), so local mode uses a
 * short-lived docker:cli container that mounts host paths via the daemon.
 */
void runRemote(String remoteScript) {
  if (params.DEPLOY_MODE != 'ssh') {
    writeFile file: 'deploy-remote.sh', text: remoteScript + '\n'
    sh """
      set -e
      # Prefer direct path if Jenkins can see it (unusual); else helper container.
      if [ -d '${params.DEPLOY_PATH}' ]; then
        bash deploy-remote.sh
        exit 0
      fi

      echo "DEPLOY_PATH not in Jenkins filesystem — using docker:cli helper with host mounts"
      # Mount /root so compose env_file paths like /root/atk-store-secrets/aws.env resolve.
      docker run --rm -i \\
        -v /var/run/docker.sock:/var/run/docker.sock \\
        -v '${params.DEPLOY_PATH}:${params.DEPLOY_PATH}' \\
        -v /root:/root \\
        -w '${params.DEPLOY_PATH}' \\
        docker:27-cli \\
        sh -s < deploy-remote.sh
    """
    return
  }

  withCredentials([sshUserPrivateKey(
    credentialsId: params.SSH_CRED_ID,
    keyFileVariable: 'SSH_KEY',
    usernameVariable: 'SSH_USER'
  )]) {
    writeFile file: 'deploy-remote.sh', text: remoteScript + '\n'
    sh """
      set -e
      chmod 400 "\$SSH_KEY"
      scp -i "\$SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \\
        deploy-remote.sh "\${SSH_USER}@${params.DEPLOY_HOST}:/tmp/atk-store-deploy-remote.sh"
      ssh -i "\$SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \\
        "\${SSH_USER}@${params.DEPLOY_HOST}" \\
        'bash /tmp/atk-store-deploy-remote.sh; rm -f /tmp/atk-store-deploy-remote.sh'
    """
  }
}
