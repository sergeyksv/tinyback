## Migration from < 2.x to 2.x

### prefixify default value for _b_ is true/false rather than 1/0
This is trivial yet important mistake that is fixed in 2.x. Changes in app logic
can be very significant because this affect data in DB. So in order to keep old
behavior use `defaults.prefixify.legacyBoolean=true'

### by default module is not provided by router unless directly requested
Use local module `reqs.router=true` when appropriate or keep old behavior
globally with `defaults.module.reqs.router=true`

### by default module router is not loaded with any express middleware
Load your own if required in module initalization or keep old behavior locally
for module with `reqs.globalUse=true` or globally with `defaults.module.reqs.globalUse=true`

### obac.register is now synchronous function
Adjust code to use it in this way or globally keep old behavior with
`defaults.obac.registerStillSync=true`

### restapi now required declaration of module / functions visibility
This is the matter of app security and there is no fallback behavior. From now
on api visibility need to be explicetly defined:
```
config:{
    restapi: {
     modules:{"statistics":1,"users":1,"web":10, // enable/disable entire modules
       "obac":{blacklist:{"register":1}}, // black list one function
       "email":{whitelist:{"getSendingStatuses":1}}} // whitelist one function
      }
    }
}
```

### tinyback now support multiprocess configuration
This can be enabled almost transparently if required by specifying module target
in load configuration to anything except "root" and "local". The important is to
prevent multiple port listeners to be started so adjust your application code
to start http server only when this condition is not passed:
```
if (app.target && app.target!="root")
  return;
```
