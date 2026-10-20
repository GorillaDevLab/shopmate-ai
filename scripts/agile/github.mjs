import { createHttp } from "./http.mjs";
import { createRepositoryApi } from "./github-repository.mjs";
import { createProjectApi } from "./github-project.mjs";

export function createGitHub(options) {
  const fetch = options.fetch ?? globalThis.fetch;
  const repository = createRepositoryApi(
    createHttp(fetch, options.repoToken),
    options.owner,
    options.repo,
  );
  const project = createProjectApi(
    options.projectToken ? createHttp(fetch, options.projectToken) : null,
    options.org,
    options.projectNumber,
    repository.fullName,
  );
  return { ...repository, ...project };
}
