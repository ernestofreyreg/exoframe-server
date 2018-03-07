// our modules
const docker = require('./docker');
const {initNetwork} = require('../docker/network');
const {getProjectConfig, nameFromImage, projectFromConfig, writeStatus} = require('../util');
const {getConfig} = require('../config');

module.exports = async ({image, username, resultStream, existing = []}) => {
  const name = nameFromImage(image);

  // get server config
  const serverConfig = getConfig();

  // get project info
  const config = getProjectConfig();

  // generate host
  // construct base domain from config, prepend with "." if it's not there
  const baseDomain = serverConfig.baseDomain ? serverConfig.baseDomain.replace(/^(\.?)/, '.') : undefined;
  // construc default domain using given base domain
  const defaultDomain = baseDomain ? `${name}${baseDomain}` : undefined;
  // construct host
  const host = config.domain === undefined ? defaultDomain : config.domain;

  // generate env vars
  const Env = config.env ? Object.keys(config.env).map(key => `${key}=${config.env[key]}`) : [];

  // generate project name
  const project = projectFromConfig({username, config});

  // construct restart policy
  const restartPolicy = config.restart || 'on-failure:2';
  const RestartPolicy = {
    Name: restartPolicy,
  };
  if (restartPolicy.includes('on-failure')) {
    let restartCount = 2;
    try {
      restartCount = parseInt(restartPolicy.split(':')[1], 10);
    } catch (e) {
      // error parsing restart count, using default value
    }
    RestartPolicy.Name = 'on-failure';
    RestartPolicy.MaximumRetryCount = restartCount;
  }
  const additionalLabels = config.labels || {};

  // construct backend name from host (if available) or name
  const backend = host && host.length ? host : name;

  const baseLabels = serverConfig.swarm ? {'traefik.port': '80'} : {};
  const Labels = Object.assign(baseLabels, additionalLabels, {
    'exoframe.deployment': name,
    'exoframe.user': username,
    'exoframe.project': project,
    'traefik.backend': backend,
  });

  // if host is set - add it to config
  if (host && host.length) {
    Labels['traefik.frontend.rule'] = `Host:${host}`;
  }

  // if running in swarm mode - run traefik as swarm service
  if (serverConfig.swarm) {
    // create service config
    const serviceConfig = {
      Name: name,
      Labels,
      TaskTemplate: {
        ContainerSpec: {
          Image: image,
          Env,
        },
        Resources: {
          Limits: {},
          Reservations: {},
        },
        RestartPolicy,
        Placement: {},
      },
      Mode: {
        Replicated: {
          Replicas: 1,
        },
      },
      UpdateConfig: {
        Parallelism: 2, // allow 2 instances to run at the same time
        Delay: 10000000000, // 10s
        Order: 'start-first', // start new instance first, then remove old one
      },
      Networks: [
        {
          Target: serverConfig.exoframeNetworkSwarm,
          Aliases: config.hostname && config.hostname.length ? [config.hostname] : [],
        },
      ],
    };

    // try to find existing service
    const existingService = existing.find(
      s => s.Spec.Labels['exoframe.project'] === project && s.Spec.TaskTemplate.ContainerSpec.Image === image
    );
    if (existingService) {
      // assign required vars from existing services
      serviceConfig.version = parseInt(existingService.Version.Index, 10);
      serviceConfig.Name = existingService.Spec.Name;
      serviceConfig.TaskTemplate.ForceUpdate = 1;

      writeStatus(resultStream, {message: 'Updating serivce with following config:', serviceConfig, level: 'verbose'});

      // update service
      const service = docker.getService(existingService.ID);
      await service.update(serviceConfig);

      writeStatus(resultStream, {message: 'Service successfully updated!', level: 'verbose'});

      return service.inspect();
    }

    writeStatus(resultStream, {message: 'Starting serivce with following config:', serviceConfig, level: 'verbose'});

    // create service
    const service = await docker.createService(serviceConfig);

    writeStatus(resultStream, {message: 'Service successfully started!', level: 'verbose'});

    return service.inspect();
  }

  // create config
  const containerConfig = {
    Image: image,
    name,
    Env,
    Labels,
    HostConfig: {
      RestartPolicy,
    },
  };

  if (config.hostname && config.hostname.length) {
    containerConfig.NetworkingConfig = {
      EndpointsConfig: {
        exoframe: {
          Aliases: [config.hostname],
        },
      },
    };
  }

  writeStatus(resultStream, {message: 'Starting container with following config:', containerConfig, level: 'verbose'});

  // create container
  const container = await docker.createContainer(containerConfig);

  // connect container to exoframe network
  const exoNet = await initNetwork();
  await exoNet.connect({
    Container: container.id,
  });

  // start container
  await container.start();

  writeStatus(resultStream, {message: 'Container successfully started!', level: 'verbose'});

  const containerInfo = await container.inspect();
  const containerData = docker.getContainer(containerInfo.Id);
  return containerData.inspect();
};
