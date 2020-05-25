const core = require('@actions/core')
const { exec } = require('@actions/exec')
const github = require('@actions/github')
const process = require('process')
const path = require('path')
const { promises: fs } = require('fs')

class NeutralExitError extends Error {}

async function main() {
  const eventObj = github.context.payload
  core.info(JSON.stringify(eventObj))
  core.info(`WORKSPACE: ${getWorkspaceDir()}`)
  const packageSrc = await fs.readFile(
    path.join(getWorkspaceDir(), 'package.json'),
    'utf8'
  )
  const packageObj = JSON.parse(packageSrc)
  core.info(JSON.stringify(packageObj))
  if (!packageObj.version) {
    throw new Error('missing version field!')
  }

  const commitMessagePattern = core.getInput('commit_message_pattern')
  const { name, email } = eventObj.repository.owner
  const config = {
    version: packageObj.version,
    commitMessagePattern,
    tagName: 'v%s',
    tagMessage: 'v%s',
    tagAuthor: {
      name: core.getInput('git_user_name') || name,
      email: core.getInput('git_user_email') || email
    }
  }
  core.info('=== config ===')
  core.info(JSON.stringify(config))

  if (checkCommit(commitMessagePattern, config.version, eventObj.commits)) {
    await publishPackage()
    core.info(`Package published: v${config.version}`)

    try {
      const tag = await createTag(config, config.version)
      core.info(`Tag created: ${tag}`)
    } catch (e) {
      core.error(`Failed to create a tag`)
      core.error(e)
    }
  } else {
    core.info('Not a release commit. Exiting.')
  }
}

function getWorkspaceDir() {
  return process.env.GITHUB_WORKSPACE || ''
}

function checkCommit(commitMessagePattern, version, commits) {
  core.info(`Looking for '${version}' using pattern ${commitMessagePattern}`)
  for (const commit of commits) {
    core.info(`Checking commit: ${commit.message}`)
    const match = commit.message.match(commitMessagePattern)
    if (match && match[1] === version) {
      core.info('Match!')
      return true
    }
  }
  return false
}

async function createTag(config, version) {
  const tagName = config.tagName.replace(/%s/g, version)
  const tagMessage = config.tagMessage.replace(/%s/g, version)

  const tagExists = await exec('git', [
    'rev-parse',
    '-q',
    '--verify',
    `refs/tags/${tagName}`
  ])
    .then(code => true)
    .catch(err => false)

  if (tagExists) {
    core.error(`Tag already exists: ${tagName}`)
    throw new NeutralExitError()
  }

  const { name, email } = config.tagAuthor
  await exec('git', ['config', '--local', 'user.name', name])
  await exec('git', ['config', '--local', 'user.email', email])

  await exec('git', ['tag', '-a', '-m', tagMessage, tagName])
  await exec('git', ['push', 'origin', `refs/tags/${tagName}`])

  return tagName
}

async function publishPackage() {
  core.startGroup(`Publishing to NPM`)
  const npmrc = path.join(getWorkspaceDir(), '.npmrc')
  const url = 'registry.npmjs.org'
  const token = core.getInput('npm_token')
  await fs.writeFile(npmrc, `//${url}/:_authToken=${token}`)
  await exec('npm', ['config', 'set', 'registry', `https://${url}`])
  await exec('npm', ['publish', '--access', 'public'])
  core.endGroup(`Publishing to NPM`)
}

if (require.main === module) {
  main().catch(e => {
    if (e instanceof NeutralExitError) {
      process.exitCode = 78
    } else {
      core.setFailed(e.message || e)
    }
  })
}
